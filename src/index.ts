import express from "express";
import "dotenv/config";
import { analyzeRepo, listRepoFiles } from "./agents/context.js";
import { findFirstTasks } from "./agents/taskFinder.js";
import { answerQuestion } from "./agents/qa.js";
import { verifyCitations } from "./agents/reviewer.js";
import { callAgent } from "./llmClient.js";
import { simpleGit } from "simple-git";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const REPO_PATH = process.env.TARGET_REPO_PATH ?? "./sample-repo";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Resolve a repoPath that may be a remote URL or a local filesystem path.
//
// If the input looks like a Git URL (http/https/git@), clone it into a
// temporary directory under ./tmp-repos/ and return:
//   { localPath: string, isTemp: true }
//
// If clone fails (bad URL, private repo, network issue) the returned promise
// rejects with a descriptive Error.
//
// For plain local paths, return:
//   { localPath: string, isTemp: false }
// ---------------------------------------------------------------------------
function isRemoteUrl(input: string): boolean {
  return (
    input.startsWith("http://") ||
    input.startsWith("https://") ||
    input.startsWith("git@")
  );
}

async function resolveRepoPath(
  input: string
): Promise<{ localPath: string; isTemp: boolean }> {
  if (!isRemoteUrl(input)) {
    return { localPath: input, isTemp: false };
  }

  const tmpDir = join(".", "tmp-repos", randomUUID());
  mkdirSync(tmpDir, { recursive: true });

  try {
    await simpleGit().clone(input, tmpDir);
  } catch (err: any) {
    // Clean up the empty directory before surfacing the error.
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(
      `Failed to clone repository "${input}": ${err?.message ?? String(err)}`
    );
  }

  return { localPath: tmpDir, isTemp: true };
}

function cleanupTemp(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Running citation verification pass rate, accumulated across all /ask calls
// in this server session.
const citationStats = { total: 0, verified: 0 };

// ---------------------------------------------------------------------------
// POST /analyze { repoPath? }
//
// Scans the repo, produces an architecture summary + module list, finds first
// tasks for a new developer, and returns a scorecard.
// Streams progress as NDJSON.
// ---------------------------------------------------------------------------
app.post("/analyze", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  const send = (event: string, data: unknown) =>
    res.write(JSON.stringify({ event, data }) + "\n");

  let isTemp = false;
  let localPath = "";

  try {
    const rawInput: string = req.body?.repoPath ?? REPO_PATH;

    // Clone remote URL into a temp folder if needed.
    ({ localPath, isTemp } = await resolveRepoPath(rawInput));

    // Stage 1: context — if this throws, nothing useful can be shown, so let
    // the outer catch handle it.
    send("stage", "context");
    const { summary, fileList, moduleList } = await analyzeRepo(localPath);
    send("context_done", { summary, moduleList, fileCount: fileList.length });

    // Stage 2: task finding — isolated so a failure here does not discard the
    // already-streamed context summary.
    send("stage", "task_finding");
    let tasks: Awaited<ReturnType<typeof findFirstTasks>> = [];
    let tasksError: string | null = null;
    try {
      await sleep(15_000);
      tasks = await findFirstTasks(localPath, fileList);
      send("tasks_done", { tasks });
    } catch (taskErr: any) {
      tasksError = taskErr?.message ?? String(taskErr);
      send("tasks_done", {
        tasks: [],
        error: "First tasks unavailable — try again. (" + tasksError + ")",
      });
    }

    // Scorecard: fraction of scanned files that ended up described in the
    // module list (i.e. "explained" by the context agent).
    const percentExplained =
      fileList.length > 0
        ? Math.round((moduleList.length / fileList.length) * 100)
        : 0;

    send("done", {
      scorecard: {
        percentExplained,
        taskCount: tasks.length,
        filesScanned: fileList.length,
        modulesDescribed: moduleList.length,
      },
    });

    res.end();
  } catch (err: any) {
    res.write(JSON.stringify({ event: "error", data: { message: err.message } }) + "\n");
    res.end();
  } finally {
    if (isTemp && localPath) cleanupTemp(localPath);
  }
});

// ---------------------------------------------------------------------------
// POST /ask { question, repoPath? }
//
// Answers a question about the repo using the QA agent, then verifies each
// citation against the actual source. Returns the answer with verified
// citations and the running session pass rate.
// Streams progress as NDJSON.
// ---------------------------------------------------------------------------
app.post("/ask", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  const send = (event: string, data: unknown) =>
    res.write(JSON.stringify({ event, data }) + "\n");

  let isTemp = false;
  let localPath = "";

  try {
    const { question } = req.body ?? {};
    if (!question) return res.status(400).json({ error: "Missing 'question' in request body" });

    const rawInput: string = req.body?.repoPath ?? REPO_PATH;

    // Clone remote URL into a temp folder if needed.
    ({ localPath, isTemp } = await resolveRepoPath(rawInput));

    send("stage", "answering");
    const fileList = listRepoFiles(localPath);
    const { answer, citations } = await answerQuestion(question, localPath, fileList);

    send("answer_done", { answer, citationCount: citations.length });

    send("stage", "verifying");
    await sleep(15_000);
    const verifiedCitations = await verifyCitations(answer, citations, localPath);

    // Accumulate into the session pass-rate tracker.
    for (const vc of verifiedCitations) {
      citationStats.total++;
      if (vc.verified) citationStats.verified++;
    }
    const sessionPassRate =
      citationStats.total > 0
        ? Math.round((citationStats.verified / citationStats.total) * 100)
        : null;

    send("done", {
      answer,
      citations: verifiedCitations,
      sessionPassRate,
    });

    res.end();
  } catch (err: any) {
    res.write(JSON.stringify({ event: "error", data: { message: err.message } }) + "\n");
    res.end();
  } finally {
    if (isTemp && localPath) cleanupTemp(localPath);
  }
});

// ---------------------------------------------------------------------------
// GET /triage
//
// Serves the Triage page (public/triage.html).
// Express static middleware would serve it too, but an explicit route gives us
// a clean URL without the .html extension.
// ---------------------------------------------------------------------------
app.get("/triage", (_req, res) => {
  res.sendFile(join(process.cwd(), "public", "triage.html"));
});

// ---------------------------------------------------------------------------
// POST /triage { trace: string }
//
// 1. Extract structured signals from the raw trace using regex patterns for
//    Python, Node/JS, and Java stack-trace formats.
// 2. Send the signals + raw text to the LLM, asking for 3–5 ranked causes.
// 3. Parse the JSON response robustly (strip markdown fences, handle garbage).
// 4. Return { extracted, causes } as JSON.
// ---------------------------------------------------------------------------

interface TriageExtracted {
  exceptionType: string | null;
  filePath: string | null;
  lineNumber: number | null;
}

interface TriageCause {
  cause: string;
  confidence: number;
  reasoning: string;
}

function extractFromTrace(trace: string): TriageExtracted {
  // Python:  File "path/to/file.py", line 42, in function_name
  const pyMatch = trace.match(/File "([^"]+)",\s*line\s*(\d+)/);
  // Node/JS: at functionName (path/to/file.js:42:7)  OR  at path/to/file.js:42:7
  const nodeMatch = trace.match(/at (?:[\w$./<>]+\s+)?\(?([^():]+\.[a-zA-Z]{1,6}):(\d+):\d+\)?/);
  // Java:    at com.example.Class.method(FileName.java:42)
  const javaMatch = trace.match(/at [\w$.]+\(([\w$.]+\.java):(\d+)\)/);

  // Pick the first frame we can extract (Python > Node > Java as precedence).
  const frameMatch = pyMatch ?? nodeMatch ?? javaMatch;

  // Exception / error type — the first word(s) before a colon on any line.
  // Covers Python (TypeError:), Java (java.lang.NullPointerException:),
  // Node (TypeError:, Error:, RangeError:), etc.
  const exceptionMatch = trace.match(/^([A-Za-z][\w$.]*(?:Error|Exception|Warning|Fault)[^:\n]*)/m);

  return {
    exceptionType: exceptionMatch ? exceptionMatch[1].trim() : null,
    filePath: frameMatch ? frameMatch[1] : null,
    lineNumber: frameMatch ? parseInt(frameMatch[2], 10) : null,
  };
}

app.post("/triage", async (req, res) => {
  try {
    const trace: string = req.body?.trace ?? "";
    if (!trace.trim()) {
      return res.status(400).json({ error: "Missing or empty 'trace' in request body." });
    }

    const extracted = extractFromTrace(trace);

    // Build a concise context block for the LLM prompt.
    const contextLines: string[] = [];
    if (extracted.exceptionType) contextLines.push(`Exception type: ${extracted.exceptionType}`);
    if (extracted.filePath)      contextLines.push(`File: ${extracted.filePath}`);
    if (extracted.lineNumber)    contextLines.push(`Line: ${extracted.lineNumber}`);
    const contextBlock = contextLines.length
      ? contextLines.join("\n") + "\n\n"
      : "";

    const raw = await callAgent({
      system:
        "You are an expert software engineer diagnosing runtime errors. " +
        "Given a stack trace or error log, output ONLY valid JSON — an array of 3 to 5 objects " +
        "ranked from most to least likely cause. Each object must have exactly these fields: " +
        '{"cause": "short label", "confidence": <integer 0-100>, "reasoning": "one sentence"}. ' +
        "No prose, no markdown, no code fences, no keys other than those three.",
      user: `${contextBlock}Stack trace:\n${trace.slice(0, 4000)}`,
      maxTokens: 800,
    });

    // Robust JSON extraction: strip markdown fences then find the array.
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "");
    const jsonMatch = stripped.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      const preview = raw.slice(0, 200).replace(/\n/g, "↵");
      return res.status(502).json({
        error: `LLM did not return a parseable JSON array. Raw response: "${preview}"`,
      });
    }

    let causes: TriageCause[];
    try {
      causes = JSON.parse(jsonMatch[0]) as TriageCause[];
    } catch {
      const preview = jsonMatch[0].slice(0, 200).replace(/\n/g, "↵");
      return res.status(502).json({
        error: `JSON.parse failed on extracted array: "${preview}"`,
      });
    }

    // Clamp confidence to [0, 100] and ensure required fields are present.
    causes = causes
      .filter((c) => c && typeof c.cause === "string")
      .map((c) => ({
        cause: String(c.cause),
        confidence: Math.min(100, Math.max(0, Number(c.confidence) || 0)),
        reasoning: String(c.reasoning ?? ""),
      }));

    return res.json({ extracted, causes });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`RepoGuide running on http://localhost:${PORT}`));

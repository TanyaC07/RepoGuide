import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { callAgentRaw } from "../llmClient.js";

export interface TaskSuggestion {
  id: string;
  title: string;
  filePath: string;
  difficulty: "easy" | "medium" | "hard";
  reason: string;
}

// Heuristic thresholds for static signals gathered before the LLM call.
const SMALL_FILE_BYTES = 300;
const TODO_PATTERN = /\b(TODO|FIXME)\b/i;
// Files whose names suggest they are unlikely to have dedicated test coverage.
const LOW_COVERAGE_PATTERN = /\/(utils?|helpers?|constants?|config|types?|index)\.(ts|tsx|js|jsx|py)$/i;

interface FileSignal {
  filePath: string;
  hasTodo: boolean;
  isSmall: boolean;
  likelyUntested: boolean;
  todoLines: string[]; // up to 3 TODO/FIXME lines for context
}

function gatherSignals(repoPath: string, fileList: string[]): FileSignal[] {
  const signals: FileSignal[] = [];
  for (const filePath of fileList) {
    const fullPath = join(repoPath, filePath);
    let content = "";
    let bytes = 0;
    try {
      bytes = statSync(fullPath).size;
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    const todoLines = lines
      .filter((l) => TODO_PATTERN.test(l))
      .map((l) => l.trim())
      .slice(0, 3);

    signals.push({
      filePath,
      hasTodo: todoLines.length > 0,
      isSmall: bytes > 0 && bytes < SMALL_FILE_BYTES,
      likelyUntested: LOW_COVERAGE_PATTERN.test(filePath),
      todoLines,
    });
  }
  return signals;
}

// Scans the repo file list for static signals (TODOs, tiny files, likely-untested
// modules) then asks the LLM to rank them as first tasks for a new developer.
export async function findFirstTasks(
  repoPath: string,
  fileList: string[]
): Promise<TaskSuggestion[]> {
  const signals = gatherSignals(repoPath, fileList);

  // Only surface files with at least one signal — keeps the prompt focused.
  // Cap at 40 entries so the prompt stays within token limits on large repos.
  const candidates = signals
    .filter((s) => s.hasTodo || s.isSmall || s.likelyUntested)
    .slice(0, 40);

  if (candidates.length === 0) {
    return [];
  }

  const candidateSummary = candidates
    .map((s) => {
      const tags: string[] = [];
      if (s.hasTodo) tags.push(`TODO/FIXME: ${s.todoLines.join(" | ")}`);
      if (s.isSmall) tags.push("very small file");
      if (s.likelyUntested) tags.push("likely low test coverage");
      return `${s.filePath} [${tags.join("; ")}]`;
    })
    .join("\n");

  const callOpts = {
    system:
      "You are a senior engineer helping a new developer find good first tasks in a codebase. " +
      "Given a list of files with signals (TODO/FIXME comments, very small files, likely-untested modules), " +
      "select the 5-10 best first tasks and rank them from easiest to hardest. " +
      "Output ONLY valid JSON: an array of objects with exactly these fields: " +
      '{"id": "ts1", "title": "...", "filePath": "...", "difficulty": "easy"|"medium"|"hard", "reason": "..."}. ' +
      "title should be a short imperative action (e.g. \"Resolve TODO in auth helper\"). " +
      "reason should be one sentence explaining why it is a good first task. No prose outside the JSON.",
    user: `Candidate files:\n${candidateSummary}`,
    maxTokens: 1200,
  };

  let { text: raw, rawData } = await callAgentRaw(callOpts);

  // Empty response: log the full provider payload (finish_reason, usage, etc.)
  // for diagnosis, then retry the call once before giving up.
  if (!raw.trim()) {
    console.warn(
      "[taskFinder] provider returned empty text on first attempt. Full response:\n",
      JSON.stringify(rawData, null, 2)
    );
    ({ text: raw, rawData } = await callAgentRaw(callOpts));
    if (!raw.trim()) {
      console.warn(
        "[taskFinder] provider returned empty text on retry. Full response:\n",
        JSON.stringify(rawData, null, 2)
      );
      throw new Error("taskFinder received an empty response from the provider after retry");
    }
  }

  // Strip markdown code fences the LLM occasionally wraps around the JSON
  // (e.g. ```json\n[...]\n``` or just ```\n[...]\n```).
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  const jsonMatch = stripped.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    const preview = raw.slice(0, 300).replace(/\n/g, "↵");
    throw new Error(`taskFinder did not return JSON (got: "${preview}")`);
  }
  return JSON.parse(jsonMatch[0]) as TaskSuggestion[];
}

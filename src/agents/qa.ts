import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callAgent } from "../llmClient.js";

export interface Citation {
  file: string;
  startLine: number;
  endLine: number; // equals startLine when the model cited a single line
}

export interface QAResult {
  answer: string;
  citations: Citation[];
}

// ---------------------------------------------------------------------------
// Keyword helpers
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "were", "this", "that", "with",
  "from", "have", "has", "had", "not", "but", "can", "what", "how",
  "which", "its", "into", "does", "did", "will", "would", "could",
  "should", "also", "then", "than", "when", "where", "who", "all",
  "each", "any", "one", "two", "use", "used", "using",
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

// ---------------------------------------------------------------------------
// Scoring + snippet extraction
// ---------------------------------------------------------------------------

const SNIPPET_CONTEXT_LINES = 3; // lines above/below a match
const MAX_SNIPPETS_PER_FILE = 8; // cap so the prompt doesn't explode
const MAX_FILES = 5;
const MIN_FILES = 3;

interface ScoredFile {
  filePath: string;
  score: number;
}

interface MatchedLine {
  lineNumber: number; // 1-based
  text: string;
}

interface FileSnippets {
  filePath: string;
  snippets: string; // pre-formatted block ready for the prompt
}

function scoreFiles(keywords: string[], fileList: string[]): ScoredFile[] {
  return fileList
    .map((filePath) => {
      // Path-level score: a keyword appearing in the file path is a strong signal.
      const pathScore = keywords.reduce(
        (acc, kw) => acc + (filePath.toLowerCase().includes(kw) ? 3 : 0),
        0
      );
      return { filePath, score: pathScore };
    })
    .sort((a, b) => b.score - a.score);
}

function matchingLines(keywords: string[], lines: string[]): MatchedLine[] {
  const matched: MatchedLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (keywords.some((kw) => lower.includes(kw))) {
      matched.push({ lineNumber: i + 1, text: lines[i] });
    }
  }
  return matched;
}

function buildSnippetBlock(
  filePath: string,
  lines: string[],
  matchedLines: MatchedLine[]
): string {
  // Build a set of line indices (0-based) to include, with context window.
  const include = new Set<number>();
  for (const { lineNumber } of matchedLines) {
    const idx = lineNumber - 1;
    for (
      let j = Math.max(0, idx - SNIPPET_CONTEXT_LINES);
      j <= Math.min(lines.length - 1, idx + SNIPPET_CONTEXT_LINES);
      j++
    ) {
      include.add(j);
    }
  }

  // Sort and render, inserting "..." between non-contiguous runs.
  const indices = Array.from(include).sort((a, b) => a - b);
  const parts: string[] = [];
  let prev = -2;
  for (const idx of indices) {
    if (idx > prev + 1) parts.push("  ...");
    parts.push(`  ${filePath}:${idx + 1}: ${lines[idx]}`);
    prev = idx;
  }
  return parts.join("\n");
}

function extractSnippets(
  repoPath: string,
  filePath: string,
  keywords: string[]
): { snippetBlock: string; contentScore: number } {
  let content: string;
  try {
    content = readFileSync(join(repoPath, filePath), "utf-8");
  } catch {
    return { snippetBlock: "", contentScore: 0 };
  }

  const lines = content.split("\n");
  const matched = matchingLines(keywords, lines).slice(0, MAX_SNIPPETS_PER_FILE);

  if (matched.length === 0) {
    return { snippetBlock: "", contentScore: 0 };
  }

  return {
    snippetBlock: buildSnippetBlock(filePath, lines, matched),
    contentScore: matched.length,
  };
}

// ---------------------------------------------------------------------------
// Citation parser
// ---------------------------------------------------------------------------

// Matches `src/foo/bar.ts:42` or `src/foo/bar.ts:8-11` that the model embeds in its answer.
// Captures an optional end-of-range so ranges are preserved rather than truncated to the
// first number.  Accepts both forward and back slashes.
const CITATION_RE = /([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,6}):(\d+)(?:-(\d+))?/g;

function parseCitations(text: string): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  let m: RegExpExecArray | null;
  // Reset lastIndex before each use since the regex is module-level const.
  CITATION_RE.lastIndex = 0;
  while ((m = CITATION_RE.exec(text)) !== null) {
    const file = m[1].replace(/\\/g, "/");
    const startLine = parseInt(m[2], 10);
    const endLine = m[3] !== undefined ? parseInt(m[3], 10) : startLine;
    const key = `${file}:${startLine}-${endLine}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({ file, startLine, endLine });
    }
  }
  return citations;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function answerQuestion(
  question: string,
  repoPath: string,
  fileList: string[]
): Promise<QAResult> {
  const keywords = tokenise(question);
  if (keywords.length === 0) {
    return { answer: "Could not extract keywords from the question.", citations: [] };
  }

  // Phase 1: cheap path-level scoring to get a candidate shortlist.
  const scored = scoreFiles(keywords, fileList);

  // Phase 2: read files and refine score by content hits.
  // Evaluate more candidates than we need so content scoring can re-rank.
  const candidates = scored.slice(0, Math.max(15, MAX_FILES * 3));
  const withContent = candidates
    .map(({ filePath, score: pathScore }) => {
      const { snippetBlock, contentScore } = extractSnippets(repoPath, filePath, keywords);
      return { filePath, snippetBlock, score: pathScore + contentScore };
    })
    .filter((c) => c.score > 0 && c.snippetBlock.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FILES);

  // Ensure we always have at least MIN_FILES files, padding with path-scored
  // candidates that had no content match but matched on path name.
  if (withContent.length < MIN_FILES) {
    for (const { filePath, score } of scored) {
      if (withContent.length >= MIN_FILES) break;
      if (withContent.some((c) => c.filePath === filePath)) continue;
      if (score === 0) continue;
      // Include without content snippets — model will still see the path.
      withContent.push({ filePath, snippetBlock: `  ${filePath}: (no matching lines)`, score });
    }
  }

  if (withContent.length === 0) {
    return {
      answer: "No relevant files found for the question.",
      citations: [],
    };
  }

  const snippetSection = withContent
    .map((c) => `### ${c.filePath}\n${c.snippetBlock}`)
    .join("\n\n");

  const raw = await callAgent({
    system:
      "You are a codebase assistant for a repo-onboarding tool. You will be given code snippets " +
      "extracted from relevant files, labelled with their path and line number in the format " +
      "`path/to/file.ext:lineNumber: <code>`. Answer the user's question using ONLY the provided " +
      "snippets — do not invent details not present in the snippets. " +
      "Cite every factual claim by embedding the exact `file:line` reference inline, for example: " +
      "`src/agents/context.ts:32`. If the snippets do not contain enough information to answer " +
      "fully, say so explicitly.",
    user: `Question: ${question}\n\nRelevant snippets:\n\n${snippetSection}`,
    maxTokens: 1000,
  });

  return {
    answer: raw,
    citations: parseCitations(raw),
  };
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callAgent } from "../llmClient.js";

export interface Citation {
  file: string;
  startLine: number;
  endLine: number; // equals startLine when the model cited a single line
}

export interface VerifiedCitation {
  citation: Citation;
  verified: boolean;
}

// ---------------------------------------------------------------------------
// Helpers shared with qa.ts (duplicated here to keep modules self-contained)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "were", "this", "that", "with",
  "from", "have", "has", "had", "not", "but", "can", "what", "how",
  "which", "its", "into", "does", "did", "will", "would", "could",
  "should", "also", "then", "than", "when", "where", "who", "all",
  "each", "any", "one", "two", "use", "used", "using",
]);

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  );
}

// Jaccard similarity between two token sets.
function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

// ---------------------------------------------------------------------------
// Source-line reader
// ---------------------------------------------------------------------------

const CONTEXT_LINES = 2; // extra lines above/below the cited range to include

function readSourceWindow(
  repoPath: string,
  file: string,
  startLine: number,
  endLine: number
): string | null {
  try {
    const content = readFileSync(join(repoPath, file), "utf-8");
    const lines = content.split("\n");
    // Cover the full cited range plus CONTEXT_LINES of padding on each side.
    const start = Math.max(0, startLine - 1 - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, endLine - 1 + CONTEXT_LINES);
    return lines.slice(start, end + 1).join("\n");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claim extractor
//
// Given the full answer text and a citation in the form "file:line", find the
// sentence(s) in the answer that are closest to that citation marker — these
// are the claims the model is asserting the citation supports.
// ---------------------------------------------------------------------------

function extractClaimNearCitation(answer: string, citation: Citation): string {
  // Try the range form first (file:start-end), fall back to just the start line.
  // The LLM may have written either form in the answer text.
  const rangeMarker = citation.startLine !== citation.endLine
    ? `${citation.file}:${citation.startLine}-${citation.endLine}`
    : null;
  const singleMarker = `${citation.file}:${citation.startLine}`;
  const marker = rangeMarker ?? singleMarker;

  // Find the character position of the citation marker in the answer.
  let markerIndex = answer.indexOf(marker);
  // If the range form wasn't found, fall back to the single-line form.
  if (markerIndex === -1 && rangeMarker !== null) {
    markerIndex = answer.indexOf(singleMarker);
  }
  if (markerIndex === -1) {
    // Citation wasn't embedded literally — fall back to the whole answer.
    return answer;
  }

  // Walk backwards to the nearest sentence boundary before the marker.
  const sentenceStart = Math.max(
    0,
    answer.lastIndexOf(".", markerIndex - 1) + 1,
    answer.lastIndexOf("\n", markerIndex - 1) + 1
  );
  // Walk forwards to the nearest sentence boundary after the marker.
  let sentenceEnd = answer.length;
  const nextPeriod = answer.indexOf(".", markerIndex + marker.length);
  const nextNewline = answer.indexOf("\n", markerIndex + marker.length);
  if (nextPeriod !== -1) sentenceEnd = Math.min(sentenceEnd, nextPeriod + 1);
  if (nextNewline !== -1) sentenceEnd = Math.min(sentenceEnd, nextNewline);

  return answer.slice(sentenceStart, sentenceEnd).trim();
}

// ---------------------------------------------------------------------------
// Heuristic thresholds
//
// Jaccard ≥ HIGH  → verified without LLM
// Jaccard ≤ LOW   → rejected without LLM
// otherwise       → ask LLM
// ---------------------------------------------------------------------------

const JACCARD_HIGH = 0.15; // looks low but code tokens are sparse — calibrated empirically
const JACCARD_LOW = 0.02;

async function verifySingle(
  answer: string,
  citation: Citation,
  repoPath: string
): Promise<VerifiedCitation> {
  const sourceWindow = readSourceWindow(
    repoPath,
    citation.file,
    citation.startLine,
    citation.endLine
  );

  // If the file/range doesn't exist we cannot verify.
  if (sourceWindow === null) {
    return { citation, verified: false };
  }

  const claim = extractClaimNearCitation(answer, citation);
  const claimTokens = tokenise(claim);
  const sourceTokens = tokenise(sourceWindow);
  const overlap = jaccardOverlap(claimTokens, sourceTokens);

  // Fast path — clear match.
  if (overlap >= JACCARD_HIGH) {
    return { citation, verified: true };
  }

  // Fast path — clear miss.
  if (overlap <= JACCARD_LOW) {
    return { citation, verified: false };
  }

  // Inconclusive — ask the LLM.
  const lineRef = citation.startLine === citation.endLine
    ? `${citation.file}:${citation.startLine}`
    : `${citation.file}:${citation.startLine}-${citation.endLine}`;
  const raw = await callAgent({
    system:
      "You are a fact-checker for a codebase Q&A system. You will be given a claim made in an answer " +
      "and the actual source code at the cited location. Reply with exactly one word: YES if the source " +
      "code plausibly supports the claim, or NO if it does not. No explanation, no punctuation.",
    user:
      `Claim: ${claim}\n\n` +
      `Source (${lineRef}):\n${sourceWindow}`,
    maxTokens: 5,
  });

  return { citation, verified: raw.trim().toUpperCase().startsWith("Y") };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// For each citation produced by the QA agent, verifies whether the actual
// source range plausibly supports the claim made near that citation in the answer.
// Uses keyword-overlap heuristics first to avoid an LLM call on obvious
// matches/mismatches; only calls the LLM for ambiguous cases.
export async function verifyCitations(
  answer: string,
  citations: Citation[],
  repoPath: string
): Promise<VerifiedCitation[]> {
  console.log(
    `[reviewer] verifying ${citations.length} citation(s):`,
    citations.map((c) =>
      c.startLine === c.endLine
        ? `${c.file}:${c.startLine}`
        : `${c.file}:${c.startLine}-${c.endLine}`
    )
  );
  // Process in parallel — each call is independent.
  return Promise.all(citations.map((c) => verifySingle(answer, c, repoPath)));
}

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { callAgent } from "../llmClient.js";

// Root-level files that are always meaningful to surface as module entries.
const NOTABLE_ROOT_FILES = new Set([
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod",
  "README.md", "readme.md", "Makefile", "Dockerfile", "docker-compose.yml",
]);

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "bob_sessions"]);
const MAX_FILES = 25;
const MAX_CHARS_PER_FILE = 1000;

export function listRepoFiles(repoPath: string): string[] {
  return walk(repoPath, repoPath);
}

function walk(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (IGNORE.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, root, out);
    } else if (/\.(ts|tsx|js|jsx|py|md|json)$/.test(entry)) {
      out.push(relative(root, full));
    }
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

export interface RepoContext {
  summary: string;
  fileList: string[];
  moduleList: string[];
}

// Reads a local repo and produces a plain-English architecture summary plus a
// structured module list — each entry is "path/or/file.ext: one-line description".
export async function analyzeRepo(repoPath: string): Promise<RepoContext> {
  const fileList = walk(repoPath, repoPath);

  const excerpts = fileList
    .slice(0, 12)
    .map((f) => {
      const content = readFileSync(join(repoPath, f), "utf-8").slice(0, MAX_CHARS_PER_FILE);
      return `--- ${f} ---\n${content}`;
    })
    .join("\n\n");

  const contextPrompt = {
    user: `File list:\n${fileList.join("\n")}\n\nExcerpts:\n${excerpts}`,
  };

  // Only the summary needs an LLM call — the module list is derived directly
  // from the file/folder structure so it is always accurate and never empty.
  const summary = await callAgent({
    system:
      "You are a senior engineer doing rapid codebase onboarding. Given a set of file excerpts, " +
      "produce a concise architecture summary: purpose, tech stack, key modules, and coding conventions. " +
      "Keep it under 150 words total, plain prose, no tables, no headers. Be specific, not generic.",
    ...contextPrompt,
    maxTokens: 500,
  });

  const moduleList = deriveModuleList(fileList);

  return { summary, fileList, moduleList };
}

// ---------------------------------------------------------------------------
// Derive a module list directly from the scanned file list — no LLM needed.
//
// Produces entries of the form "name: <label>" where name is either:
//   - a unique top-level directory  (e.g. "src", "tests", "packages")
//   - a notable root-level file     (e.g. "package.json", "Dockerfile")
//
// This is deterministic, always works, and is never confused by how the LLM
// chooses to phrase its output.
// ---------------------------------------------------------------------------
function deriveModuleList(fileList: string[]): string[] {
  const topDirs = new Map<string, number>(); // dir name → file count
  const rootFiles: string[] = [];

  for (const filePath of fileList) {
    // Normalise to forward slashes so this works on Windows too.
    const normalised = filePath.replace(/\\/g, "/");
    const slashIdx = normalised.indexOf("/");

    if (slashIdx === -1) {
      // Root-level file.
      if (NOTABLE_ROOT_FILES.has(normalised)) {
        rootFiles.push(normalised);
      }
    } else {
      const dir = normalised.slice(0, slashIdx);
      topDirs.set(dir, (topDirs.get(dir) ?? 0) + 1);
    }
  }

  const entries: string[] = [];

  // Top-level directories, sorted by file count descending so the most
  // important directories appear first.
  for (const [dir, count] of [...topDirs.entries()].sort((a, b) => b[1] - a[1])) {
    entries.push(`${dir}/: directory (${count} file${count !== 1 ? "s" : ""})`);
  }

  // Notable root-level files (deduplicated, in discovery order).
  for (const f of [...new Set(rootFiles)]) {
    entries.push(`${f}: project file`);
  }

  return entries;
}

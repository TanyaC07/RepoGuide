# RepoGuide

**Turn any unfamiliar codebase into a guided path to your first commit.**

Built for the IBM Bob 2.0 Hackathon theme: *"Build with purpose using IBM Bob 2.0."*

RepoGuide reads a repository, explains its architecture in plain English, surfaces
safe first tasks for a new developer, and answers questions with citations it
independently verifies against the real source before showing you an answer — plus
a separate Error Triage tool for ranking likely causes of a stack trace.

## Features

1. **Dashboard** (`/`) — paste a local repo path or a GitHub URL, get a plain-English
   architecture summary, a real "% Files Explained" score, a key module/folder list,
   and 5–8 ranked first tasks (difficulty, file path, reasoning) for a new contributor.
2. **Grounded Q&A** (same page) — ask anything about the analyzed repo. Every answer
   comes with `file:line` citations, each independently re-checked by a separate
   Verifier agent against the actual source before being marked verified or
   unverified — including honestly saying "I don't have enough information" when the
   repo genuinely doesn't answer the question, rather than guessing.
3. **Error Triage** (`/triage`) — paste a stack trace or error log. Regex-based
   extraction (Python, Node/JS, and Java formats) pulls the exception type, file, and
   line, then an LLM ranks 3–5 likely causes with confidence scores, shown as a table.

## Quick start

```bash
npm install
cp .env.example .env
# fill in .env: LLM_PROVIDER=gemini (or groq) + the matching API key
# both have free tiers — no paid API required

npm run dev
# open http://localhost:3000
```

To analyze a repo, either paste a public GitHub URL directly into the dashboard input
(it clones automatically), or point `TARGET_REPO_PATH` in `.env` at a local repo.

## Project layout

src/
agents/
context.ts -- scans a repo, produces an architecture summary + module list
taskFinder.ts -- finds real first tasks (TODOs, thin test coverage, small files)
qa.ts -- grounded Q&A: retrieves relevant snippets, cites file:line
reviewer.ts -- Verifier agent: re-checks each citation against real source
llmClient.ts -- swappable LLM provider (Gemini / Groq), with retry/backoff
index.ts -- Express server: POST /analyze, POST /ask, POST /triage
public/
index.html -- animated landing page
app.html -- the dashboard (analyze + Q&A)
triage.html -- the Error Triage page


## Built with IBM Bob 2.0

Bob was used in Agent mode throughout development to build the context, task-finding,
Q&A, and citation-verification agents; to debug real issues (a JSON-escaping bug fixed
by switching to a delimited output format, a rate-limit retry system, and a citation
line-range parsing bug); and to build the entire Error Triage feature end-to-end.
Task session evidence is in [`bob_sessions/`](./bob_sessions).

## Notes

- Free-tier LLM APIs (Gemini/Groq) are rate-limited — if you hit a 429/503, the app
  retries automatically using the provider's suggested delay.
- No client, confidential, or personal data is used or required — analyze any public
  repository or your own local project.

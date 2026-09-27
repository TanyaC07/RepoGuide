# RepoGuide

**Turn any unfamiliar codebase into a guided path to your first commit.**

Built for the IBM Bob 2.0 Hackathon theme: *"Build with purpose using IBM Bob 2.0."*

RepoGuide reads a repository, explains its architecture in plain English, surfaces
safe first tasks for a new developer, and answers questions with citations it
independently verifies against the real source before showing you an answer — plus
a separate Error Triage tool for ranking likely causes of a stack trace.


🔗 **Live demo:** [RepoGuid](https://repoguide-xckc.onrender.com/)
<img width="1600" height="900" alt="image" src="https://github.com/user-attachments/assets/05eeb8f1-1feb-414b-8983-4e3719de867f" />

---

## Screenshots

**Landing page**
![RepoGuide landing page]<img width="1917" height="906" alt="image" src="https://github.com/user-attachments/assets/6100b1dd-3c86-415b-af90-adc158eda89e" />


**Dashboard — architecture summary, stats, and first tasks**
![RepoGuide dashboard]<img width="1917" height="963" alt="image" src="https://github.com/user-attachments/assets/4a348dbc-1eda-49c9-ba06-72bdbca40546" />


**Grounded Q&A with verified citations**
![Grounded Q&A with citation verification]<img width="1917" height="896" alt="image" src="https://github.com/user-attachments/assets/68cbf0f4-ccaa-407f-9fba-fc07d2241621" />


**Error Triage — ranked likely causes**
![Error Triage results table]<img width="1917" height="958" alt="image" src="https://github.com/user-attachments/assets/8c954957-3411-43ca-b0db-40a22514e72c" />


---

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
screenshots/ -- images used in this README
bob_sessions/ -- Bob IDE task session evidence


## Built with IBM Bob 2.0

Bob was used in Agent mode throughout development to build the context, task-finding,
Q&A, and citation-verification agents; to debug real issues (a JSON-escaping bug fixed
by switching to a delimited output format, a rate-limit retry system, and a citation
line-range parsing bug); and to build the entire Error Triage feature end-to-end.
Task session evidence is in [`bob_sessions/`](./bob_sessions).

## Tech stack

Node.js · TypeScript · Express · Google Gemini API · Groq API · HTML/CSS/JS

## Notes

- Free-tier LLM APIs (Gemini/Groq) are rate-limited — if you hit a 429/503, the app
  retries automatically using the provider's suggested delay.
- No client, confidential, or personal data is used or required — analyze any public
  repository or your own local project.

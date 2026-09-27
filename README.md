# Impact Engine

An idea-to-PR agent pipeline built for the IBM Bob 2.0 Hackathon theme:
**"Build with purpose using IBM Bob 2.0."**

Type a feature idea. A context agent reads the target repo, a planner splits
the idea into tasks, builder subagents implement them in parallel, an
integration step merges and tests the result, and a reviewer agent opens a
pull request with a plain-English impact report.

## Quick start

```bash
npm install
cp .env.example .env
# fill in .env: at minimum LLM_PROVIDER + the matching API key
# and TARGET_REPO_PATH pointing at a local git repo you can modify

npm run dev
# open http://localhost:3000
```

You need a local git repo to point `TARGET_REPO_PATH` at. Easiest option for
a demo: clone any small sample project (or IBM's own Galaxium Travels demo
app from the Bob docs) into `./sample-repo`.

## Project layout

```
src/
  agents/
    context.ts   -- reads repo, produces architecture summary
    planner.ts   -- turns an idea into a task list (JSON)
    builder.ts   -- implements one task, runs concurrently across tasks
    reviewer.ts  -- writes PR title/body + risk notes
  gitOps.ts       -- branches, commits, and (optionally) opens a GitHub PR
  llmClient.ts    -- swappable LLM provider (anthropic / openai / watsonx)
  index.ts        -- Express server, orchestrates the pipeline end to end
public/
  index.html      -- minimal UI: idea box + live stage progress
```

## Recommended build order (fits a 48-hour hackathon)

1. Get `context.ts` working first and demo it alone — "point this at any
   repo and get an architecture summary" is already a compelling standalone
   feature and de-risks the rest.
2. Get `planner.ts` working — idea in, task list out. Test with 2-3 example
   ideas against a small sample repo.
3. Wire up **one** builder role only (recommend `test` — lowest risk, easiest
   to verify it worked) end to end through `gitOps.ts`, even if the PR step
   just commits locally without pushing.
4. Add the reviewer stage for the impact report.
5. Only if time remains: add the second and third builder roles to actually
   show parallel subagents running together.
6. Polish the UI last, not first.

## Using this with IBM Bob IDE

Build this project inside Bob IDE so your task session summaries reflect
real work on it. Suggested prompts to give Bob as you go:

- `/init` early, so Bob keeps project context (generates AGENTS.md)
- "Explain how the pipeline in src/index.ts flows end to end"
- "Add error handling and a timeout to buildTask in src/agents/builder.ts"
- "Write unit tests for planTasks in src/agents/planner.ts"
- "Review my changes to gitOps.ts for security issues before I commit"

Remember: screenshot each task's session summary (Tasks panel → select task
→ click header) and save PNGs into `bob_sessions/` in this repo before you
submit — that folder is required for judging eligibility.

## Notes

- The `LLM_PROVIDER=watsonx` path in `llmClient.ts` is a stub — fill in your
  hackathon-provisioned watsonx.ai project id and IAM token exchange if you
  want to use it for bonus points (it's optional, not required).
- `gitOps.ts` will skip the actual GitHub PR creation if `GITHUB_TOKEN` /
  `GITHUB_REPO` aren't set, so you can demo the local diff without needing
  push access configured during early development.
- Data-set rules for this hackathon: bring your own repo/data, no client or
  confidential data, no personal information, nothing scraped from social
  media.

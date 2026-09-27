// Thin wrapper so every agent calls one function and you can swap providers
// (Anthropic Claude, OpenAI, or IBM watsonx.ai) without touching agent code.
//
// Set LLM_PROVIDER in your .env to "anthropic" | "openai" | "watsonx"

import "dotenv/config";

interface CallOptions {
  system: string;
  user: string;
  maxTokens?: number;
}

const PROVIDER = process.env.LLM_PROVIDER ?? "anthropic";

// Retries transient server errors (503 = overloaded, 429 = rate limited)
// with exponential backoff. Model APIs return these often right after a
// new model launches or under free-tier load — not a bug in your code.
function parseSuggestedDelayMs(message: string): number | null {
  const match = message.match(/retry(?:Delay":"| in )(\d+(?:\.\d+)?)s/i);
  if (!match) return null;
  return Math.ceil(parseFloat(match[1]) * 1000);
}
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const message = err.message ?? "";
      const isRetryable = /\b(503|429)\b/.test(message);
      if (!isRetryable || attempt === retries) throw err;
      const suggested = parseSuggestedDelayMs(message);
      const delayMs = Math.min(suggested ?? 1000 * 2 ** attempt, 60_000);
      console.log(`Transient error, retrying in ${delayMs}ms (attempt ${attempt + 1}/${retries})...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("unreachable");
}

export async function callAgent(opts: CallOptions): Promise<string> {
  return withRetry(() => callAgentOnce(opts));
}

// Like callAgent but also returns the full raw provider response object so
// callers can inspect finish_reason, usage, etc. when the text is empty.
export async function callAgentRaw(
  opts: CallOptions
): Promise<{ text: string; rawData: unknown }> {
  return withRetry(() => callAgentOnceRaw(opts));
}

async function callAgentOnce(opts: CallOptions): Promise<string> {
  return (await callAgentOnceRaw(opts)).text;
}

async function callAgentOnceRaw({
  system,
  user,
  maxTokens = 2000,
}: CallOptions): Promise<{ text: string; rawData: unknown }> {
  if (PROVIDER === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }]
      })
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { text: data.content.map((b: any) => b.text ?? "").join("\n"), rawData: data };
  }

  if (PROVIDER === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { text: data.choices[0].message.content, rawData: data };
  }

  if (PROVIDER === "gemini") {
    // Free tier: get a key at https://aistudio.google.com/apikey — no credit card needed.
    const model = process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY ?? ""}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: user }] }],
          systemInstruction: { parts: [{ text: system }] },
          generationConfig: { maxOutputTokens: maxTokens }
        })
      }
    );
    if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return {
      text: data.candidates[0].content.parts.map((p: any) => p.text ?? "").join("\n"),
      rawData: data,
    };
  }

  if (PROVIDER === "groq") {
    // Free tier: get a key at https://console.groq.com/keys — no credit card needed.
    const model = process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.GROQ_API_KEY ?? ""}`
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    if (!res.ok) throw new Error(`Groq API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { text: data.choices[0].message.content, rawData: data };
  }

  if (PROVIDER === "watsonx") {
    // Fill in with your watsonx.ai project id, region, and IAM token exchange.
    // See: https://bob.ibm.com/docs (watsonx-guide) for the hackathon-provisioned setup.
    throw new Error("watsonx provider not yet wired up — see comment above.");
  }

  throw new Error(`Unknown LLM_PROVIDER: ${PROVIDER}`);
}

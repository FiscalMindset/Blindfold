/**
 * Optional LLM fallback.
 *
 * Activated only when:
 *   - Engine confidence < minConfidence threshold
 *   - User opted in (enableLLMFallback = true)
 *   - API key is configured (from env, sealed or otherwise)
 *
 * The fallback call:
 *   - Re-reads the request message + KB excerpts (top-3 by intent)
 *   - Sends to the configured model with the "Blindfold expert" system prompt
 *   - Returns the answer WITHOUT citing it as authoritative; flags usedFallback
 *
 * The fallback's API key is NEVER logged. The key is held in a local binding
 * for the duration of one call and dropped.
 */

import type { ChatRequest, KnowledgeEntry } from "./types.js";

export interface FallbackResult {
  text: string;
  citations: string[];
}

export async function runFallback(
  req: ChatRequest,
  topEntries: KnowledgeEntry[],
  opts: { apiKey: string; baseUrl: string; model: string },
): Promise<FallbackResult> {
  const { apiKey, baseUrl, model } = opts;

  // Defensive redactions on the way out.
  const safeMessage = scrub(req.message);

  const system = `You are a Blindfold project expert. The user has asked a question that the rule-based engine couldn't answer confidently. You are given the user's question + the top-3 most-related KB entries from the actual project docs.

Answer the question ONLY using information present in the KB entries or general knowledge about Terminal 3 / Intel TDX. NEVER invent file paths, env vars, CLI commands, or API shapes. NEVER paste or echo a real-looking API key. If you don't know, say so plainly.

At the end, return a JSON block with citations to the KB entry IDs you used.`;

  const userMsg = [
    `User question: ${safeMessage}`,
    "",
    "Top KB entries (use these as ground truth):",
    ...topEntries.map((e, i) =>
      [
        `[${i + 1}] id=${e.id} intent=${e.intent} audience=${e.audience.join(",")} confidence=${e.confidence}`,
        `Q: ${e.question}`,
        `A: ${e.shortAnswer}`,
        `Sources: ${(e.sources ?? []).join(", ")}`,
      ].join("\n"),
    ),
    "",
    "Reply in markdown. Append at the end:",
    "```json",
    "{ \"citations\": [\"<kb id 1>\", \"<kb id 2>\"] }",
    "```",
  ].join("\n");

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  // The API key is sent as a Bearer token to `baseUrl`; refuse to hand it to a
  // non-https host (localhost excepted) so a mis-set base URL can't exfiltrate it.
  assertSafeBaseUrl(url);
  const timeoutMs = Number(process.env.BLINDFOLD_CHATBOT_LLM_TIMEOUT_MS) || 15_000;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 1500,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`fallback HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json() as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = data.choices?.[0]?.message?.content ?? "";

  // Strip <think> blocks and split off the citations JSON.
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const citations = parseCitations(cleaned);
  const text = cleaned
    .replace(/```json\s*\{[\s\S]*?\}\s*```/g, "")
    .replace(/```json[\s\S]*?```/g, "")
    .trim();

  return { text, citations };
}

function assertSafeBaseUrl(rawUrl: string): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`invalid LLM base URL: ${rawUrl}`);
  }
  const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !isLocal) {
    throw new Error(`refusing to send API key to non-https host: ${u.protocol}//${u.hostname}`);
  }
}

function parseCitations(s: string): string[] {
  const m = s.match(/```json\s*(\{[\s\S]*?\})\s*```/);
  if (!m || !m[1]) return [];
  try {
    const obj = JSON.parse(m[1]) as { citations?: string[] };
    return obj.citations ?? [];
  } catch {
    return [];
  }
}

/**
 * Redact anything that looks like a key before sending to the LLM.
 * - Bearer sk-… → Bearer __BLINDFOLD__
 * - sk_live_… / sk-… / AKIA… → __BLINDFOLD__
 * - Already-sentinel values are preserved
 */
function scrub(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9_\-]{20,}/g, "sk-__BLINDFOLD__")
    .replace(/sk_live_[A-Za-z0-9_\-]{20,}/g, "sk_live___BLINDFOLD__")
    .replace(/AKIA[A-Z0-9]{12,}/g, "AKIA__BLINDFOLD__")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "ghp___BLINDFOLD__");
}
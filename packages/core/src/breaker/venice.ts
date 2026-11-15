export const VENICE_URL = "https://api.venice.ai/api/v1/chat/completions";
/** Every breaker call is capped at this many completion tokens; the budget estimate assumes all of them. */
export const MAX_TOKENS = 2048;
const TIMEOUT_MS = 120_000;

export type ChatMessage = { role: string; content: string };
export type Usage = { prompt_tokens: number; completion_tokens: number };
export type VeniceChatOptions = { model: string; messages: ChatMessage[]; schema: object; apiKey: string };
export type VeniceChatResult = { json: unknown; usage: Usage };

/** USD per 1M tokens. */
export const PRICES: Record<string, { in: number; out: number }> = {
  "deepseek-v4-flash": { in: 0.138, out: 0.275 },
  "qwen-3-8-flash": { in: 0.14, out: 0.49 },
};

function priceOf(model: string): { in: number; out: number } {
  const p = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  // an unpriced model cannot be held to the cap: refuse it rather than count it as free
  if (!p) throw new Error(`no price for breaker model ${JSON.stringify(model)}: add it to PRICES`);
  return p;
}

export function usdOf(model: string, usage: Usage): number {
  const p = priceOf(model);
  return (p.in * usage.prompt_tokens + p.out * usage.completion_tokens) / 1e6;
}

/** Worst case for one call: ~4 chars per prompt token, and every completion token used. */
export function estimateUsd(model: string, messages: ChatMessage[]): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return usdOf(model, { prompt_tokens: chars / 4, completion_tokens: MAX_TOKENS });
}

/** The project's breaker spend against its hard cap. */
export class Budget {
  constructor(
    readonly capUsd: number,
    private spentUsd: number,
  ) {
    if (!(Number.isFinite(capUsd) && capUsd >= 0)) throw new Error(`breaker.capUsd must be a non-negative number, got ${JSON.stringify(capUsd)}`);
    if (!(Number.isFinite(spentUsd) && spentUsd >= 0)) throw new Error(`breaker spend must be a non-negative number, got ${JSON.stringify(spentUsd)}`);
  }

  get spent(): number {
    return this.spentUsd;
  }

  /** Adds one call's cost and returns it. */
  charge(model: string, usage: Usage): number {
    const usd = usdOf(model, usage);
    this.spentUsd += usd;
    return usd;
  }

  /** False when a call estimated at `estUsd` could take the spend past the cap. */
  canSpend(estUsd: number): boolean {
    return this.spentUsd + estUsd <= this.capUsd;
  }
}

/**
 * The response came back (and was billed) but its content is unusable. Carries the usage, so
 * the caller can still charge it.
 */
export class VeniceOutputError extends Error {
  constructor(
    message: string,
    readonly usage: Usage,
  ) {
    super(message);
    this.name = "VeniceOutputError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** JSON from a model reply that may wrap it in a think block or a code fence. */
export function parseReply(content: string): unknown {
  const tries = [content, content.replace(/<think>[\s\S]*?<\/think>/gi, "")];
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(tries[1]!);
  if (fence) tries.push(fence[1]!);
  const s = tries[1]!;
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
  for (const t of tries) {
    try {
      return JSON.parse(t.trim());
    } catch {
      /* next */
    }
  }
  throw new Error("reply is not JSON");
}

/**
 * One chat completion on Venice's OpenAI-compatible API with a strict JSON-schema reply.
 * A reply without `usage` is charged as the worst case (the prompt at ~4 chars a token, plus
 * every completion token), never as free.
 */
export async function veniceChat(opts: VeniceChatOptions): Promise<VeniceChatResult> {
  if (!opts.apiKey) throw new Error("VENICE_API_KEY is not set");
  const res = await fetch(VENICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      max_tokens: MAX_TOKENS,
      response_format: { type: "json_schema", json_schema: { name: "patch", schema: opts.schema, strict: true } },
      venice_parameters: { include_venice_system_prompt: false },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Venice ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Venice returned non-JSON: ${text.slice(0, 300)}`);
  }
  const u = isObj(body) && isObj(body.usage) ? body.usage : {};
  const chars = opts.messages.reduce((n, m) => n + m.content.length, 0);
  const usage: Usage = {
    prompt_tokens: count(u.prompt_tokens) ?? Math.ceil(chars / 4),
    completion_tokens: count(u.completion_tokens) ?? MAX_TOKENS,
  };
  const choice = isObj(body) && Array.isArray(body.choices) && isObj(body.choices[0]) ? body.choices[0] : undefined;
  const content = isObj(choice?.message) ? choice.message.content : undefined;
  if (typeof content !== "string" || content.trim() === "") throw new VeniceOutputError("Venice reply has no message content", usage);
  try {
    return { json: parseReply(content), usage };
  } catch {
    throw new VeniceOutputError(`Venice reply is not JSON: ${content.slice(0, 200)}`, usage);
  }
}

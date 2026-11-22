import type Anthropic from "@anthropic-ai/sdk";
import { AI_DEFAULT_MODEL, AI_PROVIDERS, type AiProvider } from "@pos/shared";
import { HttpError } from "./auth";

interface Q { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }

/** What the platform set for the helper; the key may also come from the server's environment. */
export interface AiConfig { enabled: boolean; provider: AiProvider; apiKey: string; model: string; dailyLimit: number }

const ENV_KEY: Record<AiProvider, string> = { claude: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };

export async function readAiConfig(db: Q): Promise<AiConfig> {
  const v = ((await db.query(`SELECT value FROM platform_settings WHERE key = 'ai'`)).rows[0]?.value ?? {}) as Partial<AiConfig>;
  // Settings saved before Gemini was offered were for Claude.
  const provider: AiProvider = v.provider && v.provider in AI_PROVIDERS ? v.provider : v.apiKey ? "claude" : process.env.GEMINI_API_KEY || !process.env.ANTHROPIC_API_KEY ? "gemini" : "claude";
  const model = typeof v.model === "string" && /^[a-z0-9.-]{3,60}$/.test(v.model) && v.model.startsWith(provider === "claude" ? "claude-" : "gemini-") ? v.model : AI_DEFAULT_MODEL[provider];
  return {
    enabled: v.enabled ?? true,
    provider,
    apiKey: v.apiKey || process.env[ENV_KEY[provider]] || "",
    model,
    dailyLimit: v.dailyLimit ?? 40,
  };
}

type Client = Pick<Anthropic, "beta">;
let makeClient: (apiKey: string) => Promise<Client> = async (apiKey) => {
  // Loaded only when the helper is used, so the demo and the offline edition never carry it.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 55_000 });
};
/** Tests swap the client for a fake; nothing else should. */
export const setAiClient = (f: (apiKey: string) => Promise<Client>) => { makeClient = f; };

export interface AiAsk {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  /** A JSON schema the answer must follow; without it the answer is free text. */
  schema?: Record<string, unknown>;
  effort: "low" | "medium";
}

/** One question to Claude. A refusal or a cut-off answer comes back as an error the owner can read. */
export async function askClaude(cfg: AiConfig, a: AiAsk) {
  const client = await makeClient(cfg.apiKey);
  // When a safety check declines, the API retries on a fallback model by itself (not on Haiku, which has none).
  const fallback = !cfg.model.startsWith("claude-haiku");
  let r: Anthropic.Beta.BetaMessage;
  try {
    r = await client.beta.messages.create({
      model: cfg.model as Anthropic.Model,
      max_tokens: 16000,
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      output_config: { effort: a.effort, ...(a.schema ? { format: { type: "json_schema" as const, schema: a.schema } } : {}) },
      system: a.system,
      messages: a.messages,
    });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403) throw new HttpError(503, "مفتاح المساعد الذكي غير صالح. صاحب المنصة يراجعه من لوحة المنصة.");
    if (status === 429) throw new HttpError(429, "المساعد مشغول توا. جرّب بعد دقيقة.");
    if (status === 400) throw new HttpError(400, "المساعد ما قبلش الطلب هذا (ممكن الصورة كبيرة أو مش واضحة).");
    throw new HttpError(503, "المساعد ما ردّش. تأكد من الإنترنت وجرّب مرة ثانية.");
  }
  if (r.stop_reason === "refusal") throw new HttpError(422, "المساعد ما قدرش يجاوب على هذا. جرّب صيغة ثانية.");
  if (r.stop_reason === "max_tokens") throw new HttpError(422, "الطلب طويل بزاف. قسّمه على مرتين.");
  const text = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  return { text, inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens };
}

type GeminiFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json: () => Promise<any> }>;
let geminiFetch: GeminiFetch = (url, init) => fetch(url, init);
/** Tests swap Google's endpoint for a fake; nothing else should. */
export const setGeminiFetch = (f: GeminiFetch) => { geminiFetch = f; };

type Block = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** One question to Gemini, asked and answered the same way as askClaude. */
export async function askGemini(cfg: AiConfig, a: AiAsk) {
  const contents = a.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: (typeof m.content === "string" ? [{ type: "text", text: m.content } as Block] : (m.content as Block[])).map((b) =>
      b.type === "image" ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } } : { text: b.text }),
  }));
  let res: { status: number; json: () => Promise<any> };
  try {
    res = await geminiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": cfg.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: a.system }] },
        contents,
        generationConfig: { maxOutputTokens: 16000, ...(a.schema ? { responseMimeType: "application/json", responseJsonSchema: a.schema } : {}) },
      }),
      signal: AbortSignal.timeout(55_000),
    });
  } catch {
    throw new HttpError(503, "المساعد ما ردّش. تأكد من الإنترنت وجرّب مرة ثانية.");
  }
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200) {
    const msg = String(body?.error?.message ?? "");
    if (res.status === 401 || res.status === 403 || /api key/i.test(msg)) throw new HttpError(503, "مفتاح المساعد الذكي غير صالح. صاحب المنصة يراجعه من لوحة المنصة.");
    if (res.status === 429) throw new HttpError(429, "المساعد وصل للحد المسموح عند Google توا. جرّب بعد شوية.");
    if (res.status === 404) throw new HttpError(503, "نموذج Gemini المختار مش موجود. صاحب المنصة يختار نموذج ثاني من لوحة المنصة.");
    if (res.status === 400) throw new HttpError(400, "المساعد ما قبلش الطلب هذا (ممكن الصورة كبيرة أو مش واضحة).");
    throw new HttpError(503, "المساعد ما ردّش. جرّب مرة ثانية.");
  }
  const c = body.candidates?.[0];
  if (body.promptFeedback?.blockReason || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION", "SPII"].includes(c?.finishReason)) {
    throw new HttpError(422, "المساعد ما قدرش يجاوب على هذا. جرّب صيغة ثانية.");
  }
  if (c?.finishReason === "MAX_TOKENS") throw new HttpError(422, "الطلب طويل بزاف. قسّمه على مرتين.");
  const text = ((c?.content?.parts ?? []) as { text?: string; thought?: boolean }[]).filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim();
  if (!text) throw new HttpError(502, "المساعد رجّع جواب فاضي. جرّب مرة ثانية.");
  const u = body.usageMetadata ?? {};
  return { text, inputTokens: Number(u.promptTokenCount ?? 0), outputTokens: Number(u.candidatesTokenCount ?? 0) + Number(u.thoughtsTokenCount ?? 0) };
}

/** Asks whichever company the platform picked. */
export const askAi = (cfg: AiConfig, a: AiAsk) => (cfg.provider === "gemini" ? askGemini(cfg, a) : askClaude(cfg, a));

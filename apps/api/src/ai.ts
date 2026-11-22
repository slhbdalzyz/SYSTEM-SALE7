import type Anthropic from "@anthropic-ai/sdk";
import { AI_MODELS, type AiModel } from "@pos/shared";
import { HttpError } from "./auth";

interface Q { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }

/** What the platform set for the helper; the key may also come from the server's environment. */
export interface AiConfig { enabled: boolean; apiKey: string; model: AiModel; dailyLimit: number }

export async function readAiConfig(db: Q): Promise<AiConfig> {
  const v = ((await db.query(`SELECT value FROM platform_settings WHERE key = 'ai'`)).rows[0]?.value ?? {}) as Partial<AiConfig>;
  const apiKey = v.apiKey || process.env.ANTHROPIC_API_KEY || "";
  return {
    enabled: v.enabled ?? true,
    apiKey,
    model: v.model && v.model in AI_MODELS ? v.model : "claude-opus-5-5",
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
  const fallback = cfg.model !== "claude-haiku-5-5";
  let r: Anthropic.Beta.BetaMessage;
  try {
    r = await client.beta.messages.create({
      model: cfg.model,
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

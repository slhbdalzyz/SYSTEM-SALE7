/**
 * The AI helper on «من الدفتر للنظام»: the boxes it fills on each step's hand-typing grid,
 * named the same as the grid's columns so its answer drops straight in for the owner to check.
 */
export const AI_FIELDS = {
  products: ["name", "barcode", "category", "unit", "price", "cost", "qty", "pack", "packQty", "packPrice", "weighted"],
  customers: ["name", "phone", "balance", "limit"],
  suppliers: ["name", "phone", "balance"],
} as const;
export type AiKind = keyof typeof AI_FIELDS;
export type AiRow = Record<string, string>;

/** Which company answers for the helper. The platform needs an API key from that company. */
export const AI_PROVIDERS = {
  gemini: "Gemini (Google)",
  claude: "Claude (Anthropic)",
} as const;
export type AiProvider = keyof typeof AI_PROVIDERS;

/** The models the platform can pick for each company. Gemini's names follow Google's latest model of each size. */
export const AI_MODELS: Record<AiProvider, Record<string, string>> = {
  gemini: {
    "gemini-flash-latest": "Gemini Flash · سريع ورخيص",
    "gemini-flash-lite-latest": "Gemini Flash-Lite · الأرخص",
    "gemini-pro-latest": "Gemini Pro · الأدق",
  },
  claude: {
    "claude-opus-5-5": "Claude Opus 5.5 · الأدق",
    "claude-sonnet-5-5": "Claude Sonnet 5.5 · متوازن",
    "claude-haiku-5-5": "Claude Haiku 5.5 · الأرخص والأسرع",
  },
};
export const AI_DEFAULT_MODEL: Record<AiProvider, string> = { gemini: "gemini-flash-latest", claude: "claude-opus-5-5" };
/** What a key from each company starts with, to catch a wrong paste before saving. */
export const AI_KEY_PREFIX: Record<AiProvider, string> = { gemini: "AIza", claude: "sk-ant-api" };

export interface AiStatus {
  /** The helper answers for this shop right now. */
  ready: boolean;
  /** Why not, in words the owner can act on. */
  reason: string | null;
  usedToday: number;
  dailyLimit: number;
}

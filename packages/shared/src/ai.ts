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

/** The models the platform can pick for the helper, most careful first. */
export const AI_MODELS = {
  "claude-opus-5-5": "Claude Opus 5.5 · الأدق",
  "claude-sonnet-5-5": "Claude Sonnet 5.5 · متوازن",
  "claude-haiku-5-5": "Claude Haiku 5.5 · الأرخص والأسرع",
} as const;
export type AiModel = keyof typeof AI_MODELS;

export interface AiStatus {
  /** The helper answers for this shop right now. */
  ready: boolean;
  /** Why not, in words the owner can act on. */
  reason: string | null;
  usedToday: number;
  dailyLimit: number;
}

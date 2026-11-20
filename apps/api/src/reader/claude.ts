import Anthropic from "@anthropic-ai/sdk";
import { PAPER_COLUMNS, ReaderError, cleanRows, type PageReader, type PaperKind } from "./reader";

const TITLES: Record<PaperKind, string> = { products: "الأصناف والكميات", customers: "دفتر ديون العملاء", suppliers: "حسابات الموردين" };

/** The JSON shape the answer must follow: { rows: [{ column: text, … }] }. */
function schemaFor(kind: PaperKind) {
  const keys = Object.keys(PAPER_COLUMNS[kind]);
  return {
    type: "object",
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: Object.fromEntries(keys.map((k) => [k, { type: "string", description: PAPER_COLUMNS[kind][k] }])),
          required: keys,
          additionalProperties: false,
        },
      },
    },
    required: ["rows"],
    additionalProperties: false,
  };
}

const SYSTEM = `You transcribe photos of pages from the paper notebooks of small Libyan shops into table rows.
The writing is usually handwritten Arabic, sometimes with Western or Eastern Arabic digits, crossed-out lines and running totals.
Rules:
- One row per line of the page that is an entry; skip headings, dates, page totals and lines that are fully crossed out.
- Copy names as written (fix nothing but obvious spelling slips). Do not invent entries or values.
- Numbers: Western digits only, a dot for decimals, no currency words or thousands separators. Libyan dinars.
- A value you cannot read or that is not written stays an empty string.
- When a customer line shows what they took and what they paid, the balance is what is still owed.`;

/** Reads notebook pages with Claude. The key comes from ANTHROPIC_API_KEY unless one is passed. */
export function claudeReader(apiKey?: string): PageReader {
  const client = new Anthropic(apiKey ? { apiKey } : {});
  return {
    name: "claude",
    async read(kind, image) {
      const cols = Object.entries(PAPER_COLUMNS[kind]).map(([k, v]) => `${k}: ${v}`).join("\n");
      const res = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        // If a safety check declines the request, the API retries it on a fallback model by itself.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: schemaFor(kind) } },
        system: SYSTEM,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
            { type: "text", text: `This page is from the shop's «${TITLES[kind]}». Columns:\n${cols}` },
          ],
        }],
      });
      if (res.stop_reason === "refusal") throw new ReaderError("ما قدرناش نقراو الصورة هذي. جرّب صورة ثانية.");
      if (res.stop_reason === "max_tokens") throw new ReaderError("الصفحة طويلة برشا. صوّر نصها في صورة ونصها في صورة.");
      const text = res.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") throw new ReaderError("ما طلعش شي من الصورة.");
      try {
        return cleanRows(kind, (JSON.parse(text.text) as { rows: unknown }).rows);
      } catch {
        throw new ReaderError("ما قدرناش نفهموا الصفحة. جرّب صورة أوضح.");
      }
    },
  };
}

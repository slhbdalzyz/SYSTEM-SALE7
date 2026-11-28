import { z } from "zod";
import type { BusinessType } from "./business";

/**
 * The cashier screen's layouts. One screen, arranged for the kind of work: a fast grocery till,
 * a restaurant's picture grid, clothes by model, a pharmacy, phones and parts, wholesale, and a
 * touch screen. The owner picks one for the shop, a till or a cashier; the cashier only changes
 * how it looks (size, dark mode).
 */
export const TILL_LAYOUTS = ["standard", "fast", "restaurant", "clothing", "pharmacy", "tech", "wholesale", "touch"] as const;
export type TillLayout = (typeof TILL_LAYOUTS)[number];

/** The cashier's buttons, by id, in the default order. */
export const TILL_BUTTONS = [
  "qty", "price", "discount", "remove", "alternatives", "quote", "deal", "kit", "note", "hold", "held",
  "customer", "return", "reprint", "a4", "drawerOpen", "drawerMove", "loans", "void", "keys",
] as const;
export type TillButton = (typeof TILL_BUTTONS)[number];
export const TILL_BUTTON_LABELS: Record<TillButton, string> = {
  qty: "الكمية", price: "تعديل السعر", discount: "خصم على الفاتورة", remove: "حذف الصنف", alternatives: "البدائل",
  quote: "عرض سعر", deal: "مشروع / توصيل", kit: "قائمة جاهزة", note: "ملاحظة", hold: "تعليق", held: "الفواتير المعلقة",
  customer: "العميل / تسديد", return: "مرتجع", reprint: "إعادة طباعة", a4: "طباعة A4", drawerOpen: "فتح الدرج",
  drawerMove: "إيداع / سحب", loans: "سلف وأمانات", void: "إلغاء الفاتورة", keys: "الاختصارات",
};

/** Keyboard actions the owner can move to another key. */
export const TILL_ACTIONS = ["help", "search", "customer", "qty", "price", "discount", "reprint", "hold", "held", "return", "drawerOpen", "pay"] as const;
export type TillAction = (typeof TILL_ACTIONS)[number];
export const TILL_ACTION_LABELS: Record<TillAction, string> = {
  help: "قائمة الاختصارات", search: "خانة الباركود والبحث", customer: "العميل / تسديد دين", qty: "كمية الصنف المختار",
  price: "تعديل سعر الصنف", discount: "خصم على الفاتورة", reprint: "إعادة طباعة آخر فاتورة", hold: "تعليق الفاتورة",
  held: "الفواتير المعلقة", return: "مرتجع", drawerOpen: "فتح الدرج", pay: "الدفع",
};
export const DEFAULT_KEYS: Record<TillAction, string> = {
  help: "F1", search: "F2", customer: "F3", qty: "F4", price: "F5", discount: "F6", reprint: "F7", hold: "F8", held: "F9", return: "F10", drawerOpen: "F11", pay: "F12",
};
export const FUNCTION_KEYS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"] as const;

export interface LayoutSpec {
  label: string;
  icon: string;
  text: string;
  /** Items as tiles by department, to tap instead of scan. */
  grid: boolean;
  /** Cash buttons under the total: exact amount and notes, paid in one tap. */
  fastCash: boolean;
  /** Large buttons for a touch screen, numbers typed on screen. */
  touch: boolean;
  /** The bill asks for its customer before anything else (wholesale, contracts). */
  customerFirst: boolean;
  /** The total, the pieces and the change, large at the top. */
  bigTotal: boolean;
  /** The buttons shown first, in this order; the rest follow as usual. */
  first: TillButton[];
  /** Buttons this layout does not show unless the owner turns them on. */
  hide: TillButton[];
  /** What the search box says. */
  placeholder?: string;
}

export const LAYOUT_SPECS: Record<TillLayout, LayoutSpec> = {
  standard: { label: "عادية", icon: "🧾", text: "الشاشة المعروفة: باركود وبحث وكل الأزرار.", grid: false, fastCash: false, touch: false, customerFirst: false, bigTotal: false, first: [], hide: [] },
  fast: {
    label: "بيع سريع (مواد غذائية)", icon: "⚡", text: "الباركود والميزان أولاً، ودفع كاش بزر واحد: بالضبط أو ورقة. الفاتورة تنطبع وتتفرّغ بروحها.",
    grid: false, fastCash: true, touch: false, customerFirst: false, bigTotal: true, first: ["qty", "remove", "hold", "held", "customer", "return"], hide: ["quote", "deal", "kit", "note", "a4"],
  },
  restaurant: {
    label: "مطعم وكافيه", icon: "🍽️", text: "أصناف بالأقسام في مربعات كبيرة، والطاولات وسفري وتوصيل والمطبخ فوق.",
    grid: true, fastCash: true, touch: false, customerFirst: false, bigTotal: false, first: ["note", "qty", "remove", "hold", "held", "discount"], hide: ["quote", "deal", "kit", "alternatives", "a4"],
    placeholder: "دوّر على صنف، أو اختار من المربعات",
  },
  clothing: {
    label: "ملابس وأحذية", icon: "👕", text: "الموديلات في مربعات، والمقاس واللون من جدول، والتبديل والمرتجع قريبين.",
    grid: true, fastCash: false, touch: false, customerFirst: false, bigTotal: false, first: ["return", "discount", "qty", "remove", "customer", "hold"], hide: ["alternatives", "kit"],
    placeholder: "امسح الباركود أو اكتب اسم الموديل",
  },
  pharmacy: {
    label: "صيدلية", icon: "💊", text: "البحث بالاسم التجاري والعلمي، والبديل والوصفة والصلاحية ظاهرين.",
    grid: false, fastCash: false, touch: false, customerFirst: false, bigTotal: false, first: ["alternatives", "qty", "remove", "customer", "return"], hide: ["deal", "kit"],
    placeholder: "امسح الباركود أو اكتب الاسم التجاري أو العلمي",
  },
  tech: {
    label: "هواتف وإلكترونيات وقطع غيار", icon: "📱", text: "رقم الجهاز (IMEI) والضمان والأقساط والصيانة في نفس الشاشة.",
    grid: false, fastCash: false, touch: false, customerFirst: false, bigTotal: false, first: ["customer", "alternatives", "note", "deal", "quote", "return", "a4"], hide: [],
    placeholder: "امسح الباركود أو رقم القطعة أو اكتب الاسم",
  },
  wholesale: {
    label: "مواد بناء وجملة", icon: "🏗️", text: "العميل أولاً بسعر الجملة، كميات كبيرة، فاتورة A4 وعرض سعر وتوصيل.",
    grid: false, fastCash: false, touch: false, customerFirst: true, bigTotal: false, first: ["customer", "quote", "deal", "a4", "kit", "discount", "qty"], hide: [],
  },
  touch: {
    label: "شاشة لمس (تابلت)", icon: "👆", text: "أزرار كبيرة من غير كيبورد، والأصناف في مربعات. تنفع لأي نشاط.",
    grid: true, fastCash: true, touch: true, customerFirst: false, bigTotal: true, first: ["qty", "remove", "customer", "hold", "held", "return"], hide: ["keys", "a4"],
  },
};

/** The layout a kind of shop starts with. */
export function layoutForBusiness(t: BusinessType | string | null | undefined): TillLayout {
  switch (t) {
    case "grocery": case "butcher": case "bakery": case "perfume": case "stationery": return "fast";
    case "restaurant": return "restaurant";
    case "clothing": return "clothing";
    case "pharmacy": return "pharmacy";
    case "electronics": case "auto_parts": return "tech";
    case "building": case "wholesale": case "furniture": return "wholesale";
    default: return "standard";
  }
}


/**
 * The screen's frame, apart from the buttons: where the search, the tiles, the cart, the total
 * and the buttons sit. Up to three columns (the first is on the right, as Arabic reads) and an
 * optional bar under them, which on a tablet becomes a sheet pulled up from the bottom.
 */
export const TILL_BLOCKS = ["scan", "grid", "quick", "tabs", "cart", "totals", "keys"] as const;
export type TillBlock = (typeof TILL_BLOCKS)[number];
export const TILL_BLOCK_LABELS: Record<TillBlock, string> = {
  scan: "🔎 الباركود والبحث", grid: "🟦 مربعات الأصناف", quick: "🔘 الأزرار السريعة", tabs: "👥 الزبائن المفتوحين",
  cart: "🛒 السلة", totals: "💰 المجموع", keys: "⌨️ الأزرار والدفع",
};
/** A screen can't sell without these. */
export const REQUIRED_BLOCKS: TillBlock[] = ["scan", "cart", "totals", "keys"];
export const COLUMN_WIDTHS = ["1fr", "1.3fr", "1.6fr", "2fr", "260px", "300px", "340px", "380px", "440px"] as const;

export const structureSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(40),
  icon: z.string().max(8).default("🧩"),
  cols: z.array(z.object({ w: z.enum(COLUMN_WIDTHS), blocks: z.array(z.enum(TILL_BLOCKS)).max(TILL_BLOCKS.length) })).min(1).max(3),
  /** Blocks in a bar under the columns. */
  bottom: z.array(z.enum(TILL_BLOCKS)).max(TILL_BLOCKS.length).default([]),
  /** The bar is a sheet the cashier pulls up (a tablet held upright). */
  sheet: z.boolean().default(false),
  /** Only the first buttons show; the rest open from «⋯ المزيد». */
  collapseKeys: z.boolean().default(false),
  /** The tiles show on every layout, not only the restaurant's and the clothes shop's. */
  showGrid: z.boolean().default(false),
  /** The departments run down the side of the tiles instead of across the top. */
  sideCats: z.boolean().default(false),
});
export type TillStructure = z.infer<typeof structureSchema>;

const col = (w: (typeof COLUMN_WIDTHS)[number], ...blocks: TillBlock[]) => ({ w, blocks });
const MAIN: TillBlock[] = ["scan", "grid", "quick", "tabs", "cart"];
export const STRUCTURES: TillStructure[] = [
  { id: "classic", name: "كلاسيكي", icon: "🧾", cols: [col("1fr", ...MAIN), col("380px", "totals", "keys")], bottom: [], sheet: false, collapseKeys: false, showGrid: false, sideCats: false },
  { id: "mirror", name: "معكوس", icon: "🔁", cols: [col("380px", "totals", "keys"), col("1fr", ...MAIN)], bottom: [], sheet: false, collapseKeys: false, showGrid: false, sideCats: false },
  { id: "three", name: "ثلاث أعمدة", icon: "🍽️", cols: [col("1.3fr", "scan", "grid", "quick"), col("1.3fr", "tabs", "cart"), col("340px", "totals", "keys")], bottom: [], sheet: false, collapseKeys: false, showGrid: true, sideCats: true },
  { id: "wide", name: "سوبرماركت عريض", icon: "🛒", cols: [col("1fr", ...MAIN)], bottom: ["totals", "keys"], sheet: false, collapseKeys: false, showGrid: false, sideCats: false },
  { id: "compact", name: "مضغوط (لابتوب)", icon: "💻", cols: [col("1fr", ...MAIN), col("300px", "totals", "keys")], bottom: [], sheet: false, collapseKeys: true, showGrid: false, sideCats: false },
  { id: "tablet", name: "تابلت عمودي", icon: "📲", cols: [col("1fr", "scan", "grid", "quick")], bottom: ["tabs", "cart", "totals", "keys"], sheet: true, collapseKeys: true, showGrid: true, sideCats: false },
];
export const STRUCTURE_TEXT: Record<string, string> = {
  classic: "السلة يمين والمجموع والأزرار يسار.",
  mirror: "المجموع والأزرار يمين والسلة يسار.",
  three: "الأقسام والمربعات، وبعدها السلة، وبعدها المجموع.",
  wide: "السلة بعرض الشاشة، والمجموع والدفع في شريط تحت.",
  compact: "للشاشات الصغيرة: أزرار أقل والباقي في «المزيد».",
  tablet: "المربعات فوق، والسلة والدفع تطلع من تحت.",
};

/** Each block once, and the ones a sale needs always somewhere. */
export function normalizeStructure(st: TillStructure): TillStructure {
  const seen = new Set<TillBlock>();
  const keep = (list: TillBlock[]) => list.filter((b) => (seen.has(b) ? false : (seen.add(b), true)));
  const cols = st.cols.map((c) => ({ ...c, blocks: keep(c.blocks) }));
  const bottom = keep(st.bottom);
  const missing = REQUIRED_BLOCKS.filter((b) => !seen.has(b));
  if (missing.length) cols[cols.length - 1].blocks.push(...missing);
  return { ...st, cols, bottom };
}

export const TILL_THEMES = ["light", "dark", "blue", "green", "purple", "sand", "contrast"] as const;
export type TillTheme = (typeof TILL_THEMES)[number];
export const THEME_INFO: Record<TillTheme, { label: string; bg: string; panel: string; brand: string; ink: string }> = {
  light: { label: "فاتح", bg: "#f1f5f9", panel: "#ffffff", brand: "#0f766e", ink: "#0f172a" },
  dark: { label: "داكن", bg: "#0b1220", panel: "#111827", brand: "#14b8a6", ink: "#e2e8f0" },
  blue: { label: "أزرق", bg: "#eff6ff", panel: "#ffffff", brand: "#1d4ed8", ink: "#0f172a" },
  green: { label: "أخضر", bg: "#f0fdf4", panel: "#ffffff", brand: "#15803d", ink: "#052e16" },
  purple: { label: "بنفسجي", bg: "#f5f3ff", panel: "#ffffff", brand: "#6d28d9", ink: "#1e1b4b" },
  sand: { label: "رملي", bg: "#f5efe3", panel: "#fffdf8", brand: "#b45309", ink: "#292524" },
  contrast: { label: "تباين عالي", bg: "#ffffff", panel: "#ffffff", brand: "#000000", ink: "#000000" },
};
export const TILL_FONTS = ["system", "tahoma", "arial", "naskh", "kufi"] as const;
export const FONT_LABELS: Record<(typeof TILL_FONTS)[number], string> = { system: "خط الجهاز", tahoma: "Tahoma", arial: "Arial", naskh: "نسخ", kufi: "كوفي" };
export const TILL_DENSITIES = ["comfortable", "compact"] as const;

const pickMap = z.record(z.string().uuid(), z.string().max(40));

const layoutId = z.enum(TILL_LAYOUTS);

export const tillLayoutSchema = z.object({
  /** The shop's layout; "auto" follows the kind of shop. */
  shop: z.union([layoutId, z.literal("auto")]).default("auto"),
  /** A till's own layout, over the shop's. */
  devices: z.record(z.string().uuid(), layoutId).default({}),
  /** A cashier's own layout, over the till's. */
  users: z.record(z.string().uuid(), layoutId).default({}),
  /** Buttons the owner shows or hides, over the layout's choice. */
  buttons: z.record(z.enum(TILL_BUTTONS), z.boolean()).default({}),
  /** The owner's order for the buttons; any not listed keep the layout's order after these. */
  order: z.array(z.enum(TILL_BUTTONS)).max(TILL_BUTTONS.length).default([]),
  /** Keys moved by the owner: action → F1…F12. */
  keys: z.record(z.enum(TILL_ACTIONS), z.enum(FUNCTION_KEYS)).default({}),
  /** Show the total, the pieces and the change large on every layout. null = as the layout says. */
  bigTotal: z.boolean().nullable().default(null),
  /** The notes on the one-tap cash buttons, in dinars. */
  cashNotes: z.array(z.number().positive().max(1000)).max(6).default([50, 20, 10, 5]),
  /** The screen's frame for the shop, a till and a cashier: a ready one's id or one of the shop's own. */
  frame: z.object({ shop: z.string().max(40).default("classic"), devices: pickMap.default({}), users: pickMap.default({}) }).default({}),
  /** Frames the owner built or copied from the platform's library. */
  structures: z.array(structureSchema).max(20).default([]),
  /** Colours, spacing and type; a cashier can pick other colours for themselves. */
  theme: z.object({
    name: z.enum(TILL_THEMES).default("light"),
    density: z.enum(TILL_DENSITIES).default("comfortable"),
    font: z.enum(TILL_FONTS).default("system"),
  }).default({}),
});
export type TillLayoutSettings = z.infer<typeof tillLayoutSchema>;

/** The layout this cashier gets on this till: the cashier's, else the till's, else the shop's. */
export function pickLayout(s: TillLayoutSettings, business: string | null | undefined, deviceId?: string | null, userId?: string | null): TillLayout {
  return (userId && s.users[userId]) || (deviceId && s.devices[deviceId]) || (s.shop === "auto" ? layoutForBusiness(business) : s.shop);
}

/** The buttons to show, in order: the owner's order first, then the layout's, then the rest. */
export function tillButtons(s: TillLayoutSettings, layout: TillLayout): TillButton[] {
  const spec = LAYOUT_SPECS[layout];
  const seen = new Set<TillButton>();
  const out: TillButton[] = [];
  for (const b of [...s.order, ...spec.first, ...TILL_BUTTONS]) {
    if (seen.has(b)) continue;
    seen.add(b);
    const shown = s.buttons[b] ?? !spec.hide.includes(b);
    if (shown) out.push(b);
  }
  return out;
}

/** Key → action, with the owner's moves applied; a key given to two actions keeps the last one. */
export function keyMap(s: TillLayoutSettings): Record<string, TillAction> {
  const keys = { ...DEFAULT_KEYS };
  for (const [a, k] of Object.entries(s.keys) as [TillAction, string][]) {
    // The action that had this key swaps to the moved action's old key.
    const other = (Object.keys(keys) as TillAction[]).find((x) => keys[x] === k && x !== a);
    if (other) keys[other] = keys[a];
    keys[a] = k;
  }
  const out: Record<string, TillAction> = {};
  for (const [a, k] of Object.entries(keys) as [TillAction, string][]) out[k] = a;
  return out;
}

/** The key an action is on, for the labels on the buttons. */
export function keyOf(s: TillLayoutSettings, a: TillAction): string {
  const m = keyMap(s);
  return Object.keys(m).find((k) => m[k] === a) ?? "";
}

/** A frame by id: the ready ones, then the shop's own; anything unknown is the classic one. */
export function structureById(s: Pick<TillLayoutSettings, "structures">, id: string | null | undefined): TillStructure {
  const st = STRUCTURES.find((x) => x.id === id) ?? s.structures.find((x) => x.id === id) ?? STRUCTURES[0];
  return normalizeStructure(st);
}

/** The frame this cashier gets on this till: the cashier's, else the till's, else the shop's. */
export function pickStructure(s: TillLayoutSettings, deviceId?: string | null, userId?: string | null): TillStructure {
  const known = (id?: string) => !!id && (STRUCTURES.some((x) => x.id === id) || s.structures.some((x) => x.id === id));
  const u = userId ? s.frame.users[userId] : undefined;
  const d = deviceId ? s.frame.devices[deviceId] : undefined;
  return structureById(s, known(u) ? u : known(d) ? d : s.frame.shop);
}

/** A frame as a short code, to paste in another shop. */
export function structureCode(st: TillStructure): string {
  const json = JSON.stringify({ v: 1, ...st });
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return `SALE7-FRAME:${btoa(bin)}`;
}

/** Reads a pasted frame code; null if it isn't one. */
export function readStructureCode(code: string): TillStructure | null {
  try {
    const m = code.trim().match(/^SALE7-FRAME:([A-Za-z0-9+/=]+)$/);
    if (!m) return null;
    const bin = atob(m[1]);
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const r = structureSchema.safeParse(JSON.parse(json));
    return r.success ? normalizeStructure(r.data) : null;
  } catch {
    return null;
  }
}

/** The customer screen's slides between sales: the shop's offers, its name, a picture. */
export const displayAdsSchema = z.object({
  seconds: z.number().int().min(3).max(60).default(8),
  /** Show the slides beside the bill while the cashier rings items up, not only between sales. */
  duringSale: z.boolean().default(false),
  slides: z.array(z.object({
    id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    title: z.string().trim().max(80).default(""),
    text: z.string().trim().max(200).default(""),
    /** A small picture (a data: URL made on the owner's computer) or a link to one. */
    image: z.string().max(400_000).regex(/^(data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+|https:\/\/\S+)$/).nullable().default(null),
    bg: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0f766e"),
  })).max(8).default([]),
});
export type DisplayAds = z.infer<typeof displayAdsSchema>;

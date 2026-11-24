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
  "customer", "return", "reprint", "a4", "drawerOpen", "drawerMove", "void", "keys",
] as const;
export type TillButton = (typeof TILL_BUTTONS)[number];
export const TILL_BUTTON_LABELS: Record<TillButton, string> = {
  qty: "الكمية", price: "تعديل السعر", discount: "خصم على الفاتورة", remove: "حذف الصنف", alternatives: "البدائل",
  quote: "عرض سعر", deal: "مشروع / توصيل", kit: "قائمة جاهزة", note: "ملاحظة", hold: "تعليق", held: "الفواتير المعلقة",
  customer: "العميل / تسديد", return: "مرتجع", reprint: "إعادة طباعة", a4: "طباعة A4", drawerOpen: "فتح الدرج",
  drawerMove: "إيداع / سحب", void: "إلغاء الفاتورة", keys: "الاختصارات",
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

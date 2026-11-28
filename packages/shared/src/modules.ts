/**
 * The shop's features the owner turns on or off: each kind of shop starts with its own set, and any
 * shop can add what it needs (a phone shop that also sells clothes turns on sizes and colours) or
 * put away what it does not. Turning a feature off only hides it; nothing is deleted.
 */

export type ModuleGroup = "items" | "selling" | "making";
export const MODULE_GROUPS: Record<ModuleGroup, string> = { items: "الأصناف", selling: "البيع", making: "الإنتاج والطلبات" };

export const MODULES = [
  { key: "variants", group: "items", icon: "👕", label: "المقاسات والألوان", hint: "صنف واحد بعدة مقاسات وألوان، كل واحد بباركوده ومخزونه، وشبكة اختيار في الكاشير." },
  { key: "weighed", group: "items", icon: "⚖️", label: "البيع بالوزن والميزان", hint: "أصناف بالكيلو، كود الميزان، وقراءة باركود الميزان." },
  { key: "expiry", group: "items", icon: "⏳", label: "تواريخ الصلاحية", hint: "تاريخ الصلاحية في فواتير التوريد، وتنبيه قبل بيع منتهي." },
  { key: "pharmacy", group: "items", icon: "💊", label: "الأدوية", hint: "الاسم العلمي والبدائل، والأدوية اللي تتباع بوصفة طبية." },
  { key: "serials", group: "items", icon: "📱", label: "أرقام الأجهزة والضمان", hint: "كل جهاز برقمه (IMEI)، والضمان يطلع في الفاتورة، والبحث برقم الجهاز." },
  { key: "parts", group: "items", icon: "🚗", label: "رقم القطعة والسيارة", hint: "رقم القطعة (OEM)، السيارات اللي تركب عليها، والبدائل من ماركات ثانية." },
  { key: "location", group: "items", icon: "📍", label: "مكان الصنف في المخزن", hint: "الرف أو الصندوق، يطلع للكاشير وقت البحث." },
  { key: "services", group: "items", icon: "🛠️", label: "الخدمات", hint: "أصناف بدون مخزون: سوفتوير، تركيب، توصيل، صيانة بسعر ثابت أو وقت البيع." },
  { key: "tiers", group: "selling", icon: "🏷️", label: "أسعار الجملة والمقاول والورشة", hint: "كل زبون بنوعه، والكاشير يحسب سعره الخاص." },
  { key: "quotes", group: "selling", icon: "📄", label: "عروض الأسعار", hint: "عرض سعر يتطبع أو يتبعت واتساب، ويتفتح برقمه وقت الشراء." },
  { key: "delivery", group: "selling", icon: "🚚", label: "المشاريع والتوصيل", hint: "المشروع وعنوان التوصيل على الفاتورة، ومتابعة التوصيل." },
  { key: "installments", group: "selling", icon: "📆", label: "الأقساط", hint: "البيع بالتقسيط، الأقساط المتأخرة، والتذكير بالواتساب." },
  { key: "loans", group: "selling", icon: "🤝", label: "السلف والأمانات", hint: "فلوس تطلع من الدرج سلفة وترجع، أو فلوس يحطها حد عندك ويرفعها بعدين، كل واحدة باسم صاحبها." },
  { key: "kits", group: "selling", icon: "🎒", label: "القوائم الجاهزة", hint: "قائمة مدرسية، طقم، بوكس هدية: تنزل على الفاتورة بضغطة." },
  { key: "recipes", group: "making", icon: "🧪", label: "الوصفات والتركيبات", hint: "مكونات كل صنف أو خدمة: البيع ينقص المكونات وتعرف التكلفة الحقيقية." },
  { key: "orders", group: "making", icon: "📝", label: "الطلبيات المسبقة", hint: "طلبية بعربون وموعد تسليم، ورسالة للزبون لما تجهز." },
  { key: "repairs", group: "making", icon: "🔧", label: "الصيانة", hint: "استلام أجهزة للصيانة بإيصال، متابعة حالتها، وتسليمها." },
  { key: "tables", group: "making", icon: "🍽️", label: "الطاولات والمطبخ", hint: "الطلب على طاولة أو سفري، شاشة المطبخ، وملاحظات على الأصناف." },
  { key: "butcher", group: "making", icon: "🔪", label: "أسعار اليوم والتقطيع", hint: "تغيير أسعار اللحوم والخضرة كل يوم، وتقطيع الذبيحة لأصناف." },
] as const satisfies readonly { key: string; group: ModuleGroup; icon: string; label: string; hint: string }[];

export type ModuleKey = (typeof MODULES)[number]["key"];
export type Modules = Record<ModuleKey, boolean>;

/** What each kind of shop starts with. Everything else starts off. */
const STARTER: Record<string, ModuleKey[]> = {
  grocery: ["weighed", "expiry", "butcher"],
  clothing: ["variants", "orders"],
  pharmacy: ["expiry", "pharmacy"],
  butcher: ["weighed", "butcher"],
  restaurant: ["tables", "recipes", "orders"],
  electronics: ["serials", "repairs", "services", "quotes", "installments", "recipes"],
  building: ["tiers", "quotes", "delivery", "kits", "location", "services"],
  auto_parts: ["parts", "location", "tiers", "quotes", "orders", "kits", "services", "recipes"],
  wholesale: ["tiers", "quotes", "delivery", "expiry"],
  stationery: ["kits", "quotes", "orders", "services"],
  perfume: ["recipes", "kits", "orders", "expiry"],
  bakery: ["recipes", "orders", "delivery", "kits", "weighed", "expiry"],
  furniture: ["installments", "delivery", "quotes", "orders", "serials", "services", "recipes"],
  other: ["weighed", "expiry", "services", "quotes"],
};

/** The shop's features: what its kind starts with, changed by what the owner turned on or off. */
export function shopModules(businessType: string | null | undefined, saved?: Partial<Record<string, boolean>> | null): Modules {
  // Lending from the drawer and keeping money for people happens in every kind of shop.
  const start = new Set<string>([...(STARTER[businessType ?? "grocery"] ?? STARTER.other), "loans"]);
  return Object.fromEntries(MODULES.map((m) => [m.key, typeof saved?.[m.key] === "boolean" ? !!saved[m.key] : start.has(m.key)])) as Modules;
}

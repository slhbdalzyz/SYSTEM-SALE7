import type { PageReader, PaperRow } from "./reader";

/** For the demo and tests: "reads" a fixed page, so the whole flow can be tried without an API key. */
export function fakeReader(): PageReader {
  const pages: Record<string, PaperRow[]> = {
    products: [
      { name: "سكر 1 كغ", category: "المواد الغذائية", unit: "كيس", price: "3.5", cost: "3", qty: "40" },
      { name: "زيت ذرة 1.5 لتر", category: "المواد الغذائية", unit: "قنينة", price: "12", cost: "10.5", qty: "18" },
      { name: "حليب نيدو 900 غ", category: "الألبان والأجبان", unit: "علبة", price: "38", cost: "34", qty: "6" },
      { name: "مياه 1.5 لتر", category: "المشروبات", unit: "قنينة", price: "1", cost: "0.75", qty: "120" },
    ],
    customers: [
      { name: "الحاج علي", phone: "0912345678", balance: "145" },
      { name: "محمود الورفلي", phone: "0923456789", balance: "60.5" },
      { name: "أم سالم", phone: "", balance: "32" },
    ],
    suppliers: [
      { name: "شركة النور للتوزيع", phone: "0913332211", balance: "2400" },
      { name: "مخبز الفرح", phone: "", balance: "180" },
    ],
  };
  return { name: "demo", read: async (kind) => pages[kind].map((r) => ({ ...r })) };
}

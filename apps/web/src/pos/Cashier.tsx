import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { creditRoom, formatMoney, formatQty, pointsEarned, pointsFor, readShopSettings, type CatalogCustomer, type CatalogProduct, type LoyaltySettings, type Offer, type PaymentMethod, type QuickGroup, type QuickKey, type ShopSettings, expiryState, variantBaseName, type Prescription, kitchenDelta, sentSnapshot, ORDER_TYPE_LABELS, ORDER_TYPE_ICONS, type OrderType, type SentLine } from "@pos/shared";
import { api } from "../api";
import { db, getMeta, nextInvoiceNumber, setMeta, type HeldCart, type LocalShift } from "../localdb";
import { alternatives, findByCode, searchProducts, type Found } from "../lookup";
import { VariantPicker } from "./VariantPicker";
import { RxDialog } from "./RxDialog";
import { session, tokenClaims } from "../session";
import { loadExpiry, loadOffers, loadTables, onSync, refreshCounts, startSyncLoop, syncNow, type DiningTable, type SyncState } from "../sync";
import { NoteDialog, OrderBar, TablesDialog, type Order } from "./restaurant";
import { autoBackupIfDue } from "../owner/backup";
import type { Screen } from "../App";
import { addLine, cartTotals, lineFor, lineTotal, priceCart, switchUnit, toSaleInput, type CartLine } from "./cart";
import { AmountDialog, DrawerDialog, Modal, PayDialog, type Employee } from "./dialogs";
import { applyPrefs, loadPrefs, savePrefs, sound, type TillPrefs } from "./feel";
import { MyPay } from "../admin/MyPay";
import { Receipt, type ReceiptData } from "./Receipt";
import { CustomerDialog } from "./CustomerDialog";
import { ReturnDialog, type ReturnDone } from "./ReturnDialog";
import { PrinterDialog } from "../hardware/PrinterDialog";
import { openCustomerDisplay, openDrawer, printReceipt } from "../hardware/printer";
import { displaySender } from "../display/channel";
import { sendInvoice } from "../whatsapp";
import { shiftReport } from "./shiftReport";
import { CameraScanner, hasCamera } from "../hardware/CameraScanner";
import { QuickPad, visibleKeys } from "./quickpad";

type Dialog =
  | { kind: "pay" }
  | { kind: "weight"; product: CatalogProduct }
  | { kind: "qty"; key: string }
  | { kind: "price"; key: string; required?: boolean; open?: boolean }
  | { kind: "discount" }
  | { kind: "openShift" }
  | { kind: "closeShift"; expected: number }
  | { kind: "held"; carts: HeldCart[] }
  | { kind: "customer" }
  | { kind: "return" }
  | { kind: "printer" }
  | { kind: "mypay" }
  | { kind: "keys" }
  | { kind: "wa" }
  | { kind: "zreport"; data: ReceiptData }
  | { kind: "camera" }
  | { kind: "drawer" }
  | { kind: "prefs" }
  | { kind: "variant"; groupId: string; times: number }
  | { kind: "rx" }
  | { kind: "tables" }
  | { kind: "note"; key: string }
  | null;

/** A customer being served. Several can be open at once, one tab each. */
interface Tab {
  id: string; n: number; lines: CartLine[]; invoiceDiscount: number; customer: CatalogCustomer | null; selected: string | null; prescription?: Prescription | null;
  /** Restaurants: how the order goes out, and what the kitchen has already been told. */
  order?: Order | null; sent?: Record<string, SentLine>;
}
const emptyTab = (n: number, order: Order | null = null): Tab => ({ id: crypto.randomUUID(), n, lines: [], invoiceDiscount: 0, customer: null, selected: null, prescription: null, order, sent: {} });
const DEFAULT_ORDER: Order = { type: "takeaway" };
const today = () => new Date().toLocaleDateString("en-CA");
const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

type Shop = { name: string; settings: ShopSettings; type?: string };

/** The till's keyboard: what each key does, shown on F1. */
const KEYS: [string, string][] = [
  ["F1", "هذي القائمة"], ["F2", "خانة الباركود والبحث"], ["F3", "العميل / تسديد دين"], ["F4", "كمية الصنف المختار"],
  ["F5", "تعديل سعر الصنف المختار"], ["F6", "خصم على الفاتورة"], ["F7", "إعادة طباعة آخر فاتورة"], ["F8", "تعليق الفاتورة"],
  ["F9", "الفواتير المعلقة"], ["F10", "مرتجع"], ["F11", "فتح الدرج"], ["F12 / Ctrl+Enter", "الدفع"],
  ["↑ ↓", "التنقل بين أصناف الفاتورة"], ["+ / −", "زيادة أو نقص كمية الصنف المختار"], ["Delete", "حذف الصنف المختار"],
  ["Ctrl+Delete", "إلغاء الفاتورة كلها"], ["3*باركود", "يبيع 3 من نفس الصنف"], ["Esc", "يقفل النافذة أو يمسح البحث"],
  ["Alt+N", "زبون جديد في تبويب ثاني"], ["Alt+T", "الطاولات (مطعم)"], ["Alt+K", "أرسل للمطبخ (مطعم)"], ["Alt+M", "ملاحظة على الصنف (مطعم)"], ["Alt+1 … Alt+9", "التنقل بين الزبائن المفتوحين"], ["Alt+D", "إيداع أو سحب من الدرج"], ["Ctrl+1 … Ctrl+9", "الأزرار السريعة اللي على الشاشة"],
];

export function Cashier({ go }: { go: (s: Screen) => void }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [invoiceDiscount, setInvoiceDiscount] = useState(0);
  const [code, setCode] = useState("");
  const [results, setResults] = useState<Found[]>([]);
  const [activeResult, setActiveResult] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [shift, setShift] = useState<LocalShift | null>(null);
  const [cashierName, setCashierName] = useState("");
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [catalogSize, setCatalogSize] = useState(0);
  const [customer, setCustomer] = useState<CatalogCustomer | null>(null);
  /** The prescription seen for this customer's prescription-only medicines. */
  const [prescription, setPrescription] = useState<Prescription | null>(null);
  /** Restaurants: this customer's order type and table, and what the kitchen already has. */
  const [order, setOrder] = useState<Order>(DEFAULT_ORDER);
  const [sent, setSent] = useState<Record<string, SentLine>>({});
  const [tables, setTables] = useState<DiningTable[]>([]);
  /** A kitchen slip being printed: shown in place of the receipt until it is out. */
  const [slip, setSlip] = useState<ReceiptData | null>(null);
  /** The soonest expiry date on the shelf for each dated item, to warn before selling it. */
  const [expiry, setExpiry] = useState<Map<string, string>>(new Map());
  /** The shop's points rules, kept on the device so points work offline too. */
  const [rules, setRules] = useState<LoyaltySettings | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shop, setShop] = useState<Shop | null>(null);
  const till = (shop?.settings ?? readShopSettings({})).till;
  const restaurant = shop?.type === "restaurant";
  const scanRef = useRef<HTMLInputElement>(null);
  const device = session.device;
  const [prefs, setPrefs] = useState<TillPrefs>(loadPrefs);
  useEffect(() => applyPrefs(prefs), [prefs]);
  const [tabs, setTabs] = useState<Tab[]>(() => [emptyTab(1)]);
  const [activeTab, setActiveTab] = useState(() => tabs[0].id);
  const [mine, setMine] = useState({ count: 0, totalMinor: 0 });
  /** The last sale's change, shown big until the next item goes in (even on another customer's tab). */
  const [lastPaid, setLastPaid] = useState<{ number: string; changeMinor: number } | null>(null);
  /** An exchange under way: what the returned piece was worth, to take off the new one. */
  const [exchange, setExchange] = useState<{ number: string; creditMinor: number } | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const role = tokenClaims(session.staffToken)?.role;

  const [offers, setOffers] = useState<Offer[]>([]);
  // Offers can start or end while a cart is open, so the clock is part of the price.
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const t = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => void loadOffers().then(setOffers), [sync?.lastSync]);
  useEffect(() => void loadExpiry().then(setExpiry), [sync?.lastSync]);
  useEffect(() => void loadTables().then(setTables), [sync?.lastSync]);
  const priced = useMemo(() => priceCart(lines, offers, new Date()), [lines, offers, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const totals = useMemo(() => cartTotals(priced.lines, invoiceDiscount), [priced, invoiceDiscount]);

  const focusScan = useCallback(() => setTimeout(() => scanRef.current?.focus(), 0), []);
  const flash = (text: string, bad = false) => {
    if (bad) sound("bad", prefs.sound);
    setMessage({ text, bad });
    setTimeout(() => setMessage(null), 2500);
  };

  useEffect(() => {
    startSyncLoop();
    const off = onSync(setSync);
    (async () => {
      setCashierName((await getMeta<string>("staffName")) ?? "");
      const open = (await db.shifts.toArray()).find((s) => !s.closedAt) ?? null;
      setShift(open);
      if (!open) setDialog({ kind: "openShift" });
      setCatalogSize(await db.products.count());
      setShop((await getMeta<Shop>("shop")) ?? null);
      setRules((await getMeta<LoyaltySettings>("loyalty")) ?? null);
      // Customers left open when the till was closed or the power went: still there.
      const saved = await getMeta<{ active: string; tabs: Tab[] }>("tabs");
      if (saved?.tabs?.length && saved.tabs.some((t) => t.lines.length)) {
        const act = saved.tabs.find((t) => t.id === saved.active) ?? saved.tabs[0];
        setTabs(saved.tabs);
        setActiveTab(act.id);
        loadTab(act);
      }
      void countMine();
      try {
        const me = await api<{ tenant: { name: string; settings: unknown; loyalty?: LoyaltySettings; business_type?: string }; stores: { id: string; receipt_footer: string | null }[]; storeId: string }>("/me", { token: session.staffToken });
        await setMeta("store", { footer: me.stores.find((s) => s.id === me.storeId)?.receipt_footer });
        // The shop's name and settings: what the receipt shows and what a cashier may do.
        const next = { name: me.tenant.name, settings: readShopSettings(me.tenant.settings), type: me.tenant.business_type };
        await setMeta("shop", next);
        setShop(next);
        if (me.tenant.loyalty) {
          await setMeta("loyalty", me.tenant.loyalty);
          setRules(me.tenant.loyalty);
        }
      } catch {
        /* offline: keep the footer and settings saved last time */
      }
      // Who a bill can be put on; kept on the device so it works offline too.
      try {
        const staff = await api<Employee[]>("/payroll/employees", { token: session.staffToken });
        await setMeta("employees", staff);
        setEmployees(staff);
      } catch {
        setEmployees((await getMeta<Employee[]>("employees")) ?? []);
      }
    })();
    return () => void off();
  }, []);

  useEffect(() => {
    if (sync?.lastSync) void db.products.count().then(setCatalogSize);
  }, [sync?.lastSync]);

  // Quick keys: bread, vegetables, a bag… one tap away, set up in the admin's «أزرار الكاشير».
  // Kept on the device so they work offline; before the first fetch, the products ticked as quick.
  const [quick, setQuick] = useState<{ groups: QuickGroup[]; keys: QuickKey[] }>({ groups: [], keys: [] });
  const [quickProducts, setQuickProducts] = useState<Map<string, CatalogProduct>>(new Map());
  const [qGroup, setQGroup] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      let q = await getMeta<{ groups: QuickGroup[]; keys: QuickKey[] }>("quickKeys");
      try {
        q = await api<{ groups: QuickGroup[]; keys: QuickKey[] }>("/quick-keys/till", { token: session.staffToken });
        await setMeta("quickKeys", q);
      } catch {
        if (!q) {
          const ps = (await db.products.filter((p) => !!p.quick).toArray()).sort((a, b) => a.name.localeCompare(b.name, "ar"));
          q = { groups: [], keys: ps.map((p, i) => ({ id: p.id, groupId: null, productId: p.id, unitId: null, qtyMilli: 1000, openPrice: false, label: null, color: null, image: null, storeId: null, userId: null, sort: i })) };
        }
      }
      const ps = await db.products.bulkGet([...new Set(q.keys.map((k) => k.productId))]);
      setQuickProducts(new Map(ps.filter((p): p is CatalogProduct => !!p).map((p) => [p.id, p])));
      setQuick(q);
      setQGroup((g) => (g && q.groups.some((x) => x.id === g) ? g : null));
    })();
  }, [sync?.lastSync, catalogSize]);

  /** A key: the set unit and quantity, or the scale, or the price typed now (open price). */
  function pressKey(k: QuickKey, p: CatalogProduct) {
    const unit = p.units.find((u) => u.id === k.unitId) ?? p.units.find((u) => u.isBase) ?? p.units[0];
    if (k.openPrice) {
      const line = { ...lineFor(p, unit, k.qtyMilli), priceMinor: 0 };
      setLines((ls) => [...ls, line]);
      setSelected(line.key);
      setDialog({ kind: "price", key: line.key, required: true, open: true });
      return;
    }
    if (p.isWeighted && k.qtyMilli === 1000) return setDialog({ kind: "weight", product: p });
    put(lineFor(p, unit, k.qtyMilli));
    focusScan();
  }

  // Windows app: once a day, when online and the owner allowed it, a full copy goes to this PC's disk.
  // It checks every 10 minutes; the backup itself decides whether a day has passed.
  const online = !!sync?.lastSync;
  useEffect(() => {
    if (!online) return;
    const run = () => void autoBackupIfDue(session.staffToken);
    const first = setTimeout(run, 30_000);
    const every = setInterval(run, 10 * 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [online]);

  // The cash drawer opens only when money goes in or out of it.
  const cashMoved = (r: ReceiptData) =>
    r.sale ? r.sale.payments.some((p) => p.method === "cash") : r.ret ? r.ret.method === "cash" : r.payment?.method === "cash";

  const print = useCallback(async (r: ReceiptData, withDrawer: boolean) => {
    try {
      await printReceipt(r, { openDrawer: withDrawer && cashMoved(r) });
    } catch (e) {
      flash(`الطابعة ما ردتش: ${(e as Error).message ?? e}`, true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!receipt || receipt.copy) return;
    // Let React render the printable receipt first; the browser dialog prints that.
    // With printing switched off in the settings, only the drawer opens (when cash moved).
    const auto = receipt.shop?.settings.till.autoPrint ?? true;
    const t = setTimeout(() => {
      if (auto) void print(receipt, true);
      else if (cashMoved(receipt)) void openDrawer().catch(() => {});
    }, 50);
    return () => clearTimeout(t);
  }, [receipt, print]); // eslint-disable-line react-hooks/exhaustive-deps

  async function drawer() {
    try {
      await openDrawer();
      await api("/devices/events", { body: { action: "drawer.open" }, token: session.staffToken }).catch(() => undefined);
    } catch (e) {
      flash((e as Error).message, true);
    }
  }

  // Keep the customer-facing screen in step with the cart.
  const [display, setDisplay] = useState<ReturnType<typeof displaySender> | null>(null);
  useEffect(() => {
    const d = displaySender();
    setDisplay(d);
    return () => d.close();
  }, []);
  useEffect(() => {
    if (!display) return;
    const storeName = device?.storeName ?? "";
    if (lines.length)
      display.send({
        kind: "cart",
        storeName,
        lines: priced.lines.map((l) => ({ name: l.name, qty: l.isWeighted ? `${formatQty(l.qtyMilli, true)} كغ` : formatQty(l.qtyMilli, false), amount: formatMoney(lineTotal(l), "") })),
        total: formatMoney(totals.total),
        discount: totals.discount > 0 ? formatMoney(totals.discount) : null,
        customer: customer?.name ?? null,
      });
    else if (receipt?.sale) display.send({ kind: "paid", storeName, total: formatMoney(receipt.sale.totalMinor), change: receipt.changeMinor ? formatMoney(receipt.changeMinor) : null });
    else display.send({ kind: "idle", storeName });
  }, [lines, priced, totals, customer, receipt, display, device?.storeName]);

  function put(line: CartLine) {
    // Dated goods: the batch on the shelf may be past its date. Asked once, when the item first goes in.
    const exp = expiry.get(line.productId);
    const isNew = !lines.some((l) => l.productId === line.productId);
    if (exp && isNew) {
      const st = expiryState(exp, today(), 30);
      const date = exp.split("-").reverse().join("/");
      if (st === "expired" && !confirm(`⚠️ «${line.name}» اللي في الرف منتهي الصلاحية (${date}).\nتأكد من التاريخ على العلبة. تبيعه؟`)) return flash("ما تباعش: منتهي الصلاحية", true);
      if (st === "soon") flash(`⏳ «${line.name}» صلاحيته تخلص ${date}`);
    }
    if (line.rx && !prescription) setTimeout(() => setDialog({ kind: "rx" }), 0);
    // An item with no price yet: ask for one (if the settings allow), never sell it at zero.
    if (line.priceMinor <= 0) {
      if (!till.askPriceWhenZero) return flash(`«${line.name}» ما عندهش سعر بيع. حطله سعر من فاتورة التوريد أو الأصناف`, true);
      setLines((ls) => [...ls, line]);
      setSelected(line.key);
      setDialog({ kind: "price", key: line.key, required: true });
      return;
    }
    const r = addLine(lines, line);
    setLines(r.lines);
    setSelected(r.key);
    sound("ok", prefs.sound);
    setLastPaid(null);
  }

  async function scan(raw: string) {
    let text = raw.trim();
    if (!text) return;
    // "3*code" sells three of that item.
    let times = 1;
    const m = text.match(/^(\d+(?:\.\d+)?)\*(.+)$/);
    if (m) {
      times = Number(m[1]);
      text = m[2];
    }
    const hit = await findByCode(text);
    if (hit) {
      if (hit.qtyMilli) put(lineFor(hit.product, hit.unit, hit.qtyMilli));
      else if (hit.product.isWeighted) setDialog({ kind: "weight", product: hit.product });
      else put(lineFor(hit.product, hit.unit, Math.round(times * 1000)));
      setCode("");
      setResults([]);
      return;
    }
    const found = await searchProducts(text);
    if (found.length === 1) return pick(found[0], times);
    if (found.length) {
      setResults(found);
      setActiveResult(0);
      return;
    }
    flash(`الصنف غير موجود: ${text}`, true);
    setCode("");
  }

  function pick(p: Found, times = 1) {
    setResults([]);
    setCode("");
    // A model in several sizes or colours: pick the piece from its grid.
    if (p.variants && p.groupId) return setDialog({ kind: "variant", groupId: p.groupId, times });
    if (p.isWeighted) return setDialog({ kind: "weight", product: p });
    const unit = p.units.find((u) => u.isBase) ?? p.units[0];
    put(lineFor(p, unit, Math.round(times * 1000)));
    focusScan();
  }

  async function onType(v: string) {
    setCode(v);
    if (/^\d+$/.test(v) || v.includes("*")) return setResults([]);
    setResults(await searchProducts(v));
    setActiveResult(0);
  }

  function changeQty(key: string, delta: number) {
    setLines((ls) => ls.flatMap((l) => (l.key !== key ? [l] : l.qtyMilli + delta <= 0 ? [] : [{ ...l, qtyMilli: l.qtyMilli + delta }])));
  }

  function removeLine(key: string) {
    setLines((ls) => ls.filter((l) => l.key !== key));
    setSelected(null);
    focusScan();
  }

  function voidCart() {
    if (exchange) return cancelExchange();
    if (!lines.length) return;
    if (till.confirmClear && !confirm(`نلغي الفاتورة (${lines.length} أصناف · ${formatMoney(totals.total)})؟`)) return;
    finishCart();
    flash("تم إلغاء الفاتورة");
    focusScan();
  }

  function clearCart() {
    setLines([]);
    setInvoiceDiscount(0);
    setSelected(null);
    setCustomer(null);
    setPrescription(null);
    setOrder(DEFAULT_ORDER);
    setSent({});
  }

  // ---- Several customers at once, one tab each ----
  function loadTab(t: Tab) {
    setLines(t.lines);
    setInvoiceDiscount(t.invoiceDiscount);
    setCustomer(t.customer);
    setSelected(t.selected);
    setPrescription(t.prescription ?? null);
    setOrder(t.order ?? DEFAULT_ORDER);
    setSent(t.sent ?? {});
  }
  const current = (): Tab => ({ ...(tabs.find((t) => t.id === activeTab) ?? emptyTab(1)), lines, invoiceDiscount, customer, selected, prescription, order, sent });
  function switchTab(id: string) {
    if (id === activeTab) return;
    if (exchange) return flash("كمّل التبديل أول، أو ألغيه", true);
    const next = tabs.find((t) => t.id === id);
    if (!next) return;
    const cur = current();
    setTabs((ts) => ts.map((t) => (t.id === activeTab ? cur : t)));
    loadTab(next);
    setActiveTab(id);
    setResults([]);
    setCode("");
    focusScan();
  }
  function newTab(order: Order | null = null) {
    if (exchange) return flash("كمّل التبديل أول، أو ألغيه", true);
    // A restaurant keeps a tab open for each table, so it needs more.
    const most = restaurant ? 40 : 9;
    if (tabs.length >= most) return flash(`أقصى حد ${most} ${restaurant ? "طلب مفتوح" : "زبائن مفتوحين"}`, true);
    const cur = current();
    const t = emptyTab(Math.max(...tabs.map((x) => x.n)) + 1, order);
    setTabs((ts) => [...ts.map((x) => (x.id === activeTab ? cur : x)), t]);
    loadTab(t);
    setActiveTab(t.id);
    focusScan();
  }
  /** After a sale, a hold or a cancel: that customer's tab closes if others are open. */
  function finishCart() {
    if (tabs.length > 1) {
      const rest = tabs.filter((t) => t.id !== activeTab);
      setTabs(rest);
      loadTab(rest[0]);
      setActiveTab(rest[0].id);
    } else {
      clearCart();
    }
  }
  // Kept on the device as they change, so a crash or a power cut loses no open customer.
  useEffect(() => {
    const t = setTimeout(() => void setMeta("tabs", { active: activeTab, tabs: tabs.map((x) => (x.id === activeTab ? current() : x)) }), 400);
    return () => clearTimeout(t);
  }, [tabs, activeTab, lines, invoiceDiscount, customer, order, sent]); // eslint-disable-line react-hooks/exhaustive-deps

  /** This cashier's sales today on this till: shown in the status bar. */
  async function countMine() {
    const d = today();
    const name = (await getMeta<string>("staffName")) ?? "";
    const list = await db.sales.filter((x) => (x.kind ?? "sale") === "sale" && x.cashierName === name && new Date(x.createdAt).toLocaleDateString("en-CA") === d).toArray();
    setMine({ count: list.length, totalMinor: list.reduce((a, x) => a + x.totalMinor, 0) });
  }

  /** Money into or out of the drawer, with its reason: counted in the shift and sent to the owner. */
  async function drawerMove(kind: "in" | "out", amountMinor: number, reason: string) {
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    await db.transaction("rw", db.sales, db.outbox, async () => {
      await db.sales.put({ id, number: kind === "in" ? "إيداع" : "سحب", shiftId: shift?.id ?? null, createdAt: at, totalMinor: 0, cashInMinor: kind === "in" ? amountMinor : -amountMinor, changeMinor: 0, cashierName, input: null, kind: "drawer", reason });
      await db.outbox.add({ kind: "drawer", refId: id, payload: { id, shiftId: shift?.id ?? null, kind, amountMinor, reason, at }, createdAt: at });
    });
    setDialog(null);
    flash(`${kind === "in" ? "تم إيداع" : "تم سحب"} ${formatMoney(amountMinor)}: ${reason}`);
    void openDrawer().catch(() => undefined);
    await refreshCounts();
    void syncNow();
    focusScan();
  }

  function pickCustomer(c: CatalogCustomer | null) {
    setCustomer(c);
    if (c && c.creditLimitMinor !== null && c.creditLimitMinor > 0 && c.balanceMinor >= c.creditLimitMinor * 0.8) {
      flash(c.balanceMinor >= c.creditLimitMinor ? `⛔ ${c.name} وصل حد الدين` : `⚠️ ${c.name} قرّب من حد الدين`, true);
    }
  }

  async function pay(payments: { method: PaymentMethod; amountMinor: number }[], employeeId: string | null = null) {
    if (!device) return;
    // Whatever the kitchen has not heard of yet goes now, so nothing paid for is left unmade.
    if (restaurant && pendingKitchen.length) await sendKitchen();
    const id = crypto.randomUUID();
    const number = await nextInvoiceNumber(device.prefix);
    const sale = toSaleInput({ id, number, shiftId: shift?.id ?? null, lines, offers, invoiceDiscountMinor: invoiceDiscount, payments, customerId: customer?.id, employeeId, prescription: lines.some((l) => l.rx) ? prescription : null,
      ...(restaurant ? { orderType: order.type, tableName: order.type === "dine_in" ? order.table ?? null : null } : {}) });
    const credit = payments.filter((p) => p.method === "credit").reduce((a, p) => a + p.amountMinor, 0);
    const paid = payments.reduce((a, p) => a + p.amountMinor, 0);
    // In an exchange, what the returned piece was worth and the new one does not use goes back in cash.
    const change = paid - sale.totalMinor + (exchange ? Math.max(0, exchange.creditMinor - sale.totalMinor) : 0);
    const cashIn = payments.filter((p) => p.method === "cash").reduce((a, p) => a + p.amountMinor, 0);
    // Saved on the device first, so a sale is never lost if the internet or the server is down.
    await db.transaction("rw", db.sales, db.outbox, async () => {
      await db.sales.put({ id, number, shiftId: sale.shiftId ?? null, createdAt: sale.createdAt, totalMinor: sale.totalMinor, cashInMinor: cashIn, changeMinor: change, cashierName, input: sale });
      await db.outbox.add({ kind: "sale", refId: id, payload: sale, createdAt: sale.createdAt });
    });
    // Until the next sync, count the new debt locally so the credit limit still holds offline.
    if (customer && credit > 0) await db.customers.update(customer.id, { balanceMinor: customer.balanceMinor + credit });
    // Points too: worked out here the same way the server will, so the receipt can show them.
    let points: ReceiptData["points"];
    if (customer && rules?.enabled) {
      const pointsPaid = payments.filter((p) => p.method === "points").reduce((a, p) => a + p.amountMinor, 0);
      const spent = pointsPaid > 0 ? pointsFor(rules, pointsPaid) : 0;
      const earned = pointsEarned(rules, sale.totalMinor, pointsPaid);
      const balance = (customer.points ?? 0) - spent + earned;
      if (spent || earned) {
        await db.customers.update(customer.id, { points: balance });
        points = { earned, spent, balance };
      }
    }
    const store = await getMeta<{ footer?: string }>("store");
    setReceipt({ storeName: device.storeName, shop, footer: store?.footer, deviceName: device.name, cashierName, sale, changeMinor: change, customerName: customer?.name, customerPhone: customer?.phone, employeeName: employees.find((e) => e.id === employeeId)?.name, points });
    finishCart();
    setExchange(null);
    setDialog(null);
    sound("cash", prefs.sound);
    setLastPaid({ number, changeMinor: change });
    void countMine();
    await refreshCounts();
    void syncNow();
    focusScan();
  }

  async function returnDone(r: ReturnDone) {
    if (!device) return;
    await db.sales.put({
      id: crypto.randomUUID(), number: r.number, shiftId: shift?.id ?? null, createdAt: new Date().toISOString(), totalMinor: -r.totalMinor,
      cashInMinor: r.method === "cash" ? -r.refundMinor : 0, changeMinor: 0, cashierName, input: null, kind: "return",
    });
    const store = await getMeta<{ footer?: string }>("store");
    setReceipt({ storeName: device.storeName, shop, footer: store?.footer, deviceName: device.name, cashierName, ret: r });
    setDialog(null);
    if (r.exchange && r.refundMinor > 0) {
      setExchange({ number: r.number, creditMinor: r.refundMinor + (exchange?.creditMinor ?? 0) });
      flash("امسح القطعة الجديدة، وقيمة المرجّعة تنخصم منها");
    } else {
      flash(r.method === "cash" && r.refundMinor > 0 ? `رجّع للزبون ${formatMoney(r.refundMinor)} كاش` : "تم المرتجع");
    }
    void syncNow();
    focusScan();
  }

  /** Other brands with the same scientific name, shown in the search list to pick from. */
  async function showAlternatives() {
    const l = lines.find((x) => x.key === selected);
    const p = l && (await db.products.get(l.productId));
    if (!p?.genericName) return flash("الصنف هذا ما عندهش اسم علمي", true);
    const alts = await alternatives(p);
    if (!alts.length) return flash(`ما فيش بدائل لـ«${p.genericName}»`, true);
    setResults(alts);
    setActiveResult(0);
    flash(`بدائل ${p.genericName}: ${alts.length}`);
    focusScan();
  }

  // ---- Restaurants ----
  const pendingKitchen = useMemo(() => (restaurant ? kitchenDelta(lines, sent) : []), [restaurant, lines, sent]); // eslint-disable-line react-hooks/exhaustive-deps
  const orderLabel = (o: Order, n: number) => (o.type === "dine_in" && o.table ? o.table : `${ORDER_TYPE_LABELS[o.type]} ${n}`);

  /** Tells the kitchen what is new on this order (and what was taken off), on its screen and on paper. */
  async function sendKitchen() {
    const delta = kitchenDelta(lines, sent);
    if (!delta.length) return flash("المطبخ عنده كل شي", true);
    const n = tabs.find((t) => t.id === activeTab)?.n ?? 1;
    const at = new Date().toISOString();
    const ticket = { id: crypto.randomUUID(), label: orderLabel(order, n), orderType: order.type, tableName: order.type === "dine_in" ? order.table ?? null : null, lines: delta, createdAt: at };
    await db.outbox.add({ kind: "kitchen", refId: ticket.id, payload: ticket, createdAt: at });
    setSent(sentSnapshot(lines));
    flash(`👨‍🍳 وصل للمطبخ: ${ticket.label}`);
    if (prefs.kitchenSlip) {
      const data: ReceiptData = { storeName: device?.storeName ?? "", deviceName: device?.name ?? "", cashierName, kitchen: { label: ticket.label, orderType: order.type, at, lines: delta } };
      setSlip(data);
      await new Promise((ok) => setTimeout(ok, 60));
      await print(data, false);
      setSlip(null);
    }
    void syncNow();
    focusScan();
  }

  function setOrderType(t: OrderType) {
    if (t === "dine_in" && !order.table) return setDialog({ kind: "tables" });
    setOrder((o) => ({ type: t, table: t === "dine_in" ? o.table : null }));
    focusScan();
  }

  /** A taken table opens its order; a free one goes on this order if it is new, or starts one. */
  function pickTable(t: DiningTable) {
    setDialog(null);
    const open = tabs.find((x) => (x.id === activeTab ? order : x.order)?.table === t.name);
    if (open) return switchTab(open.id);
    if (!lines.length || !order.table) {
      setOrder({ type: "dine_in", table: t.name });
      return focusScan();
    }
    newTab({ type: "dine_in", table: t.name });
  }

  const busyTables = useMemo(() => {
    const m = new Map<string, { totalMinor: number; items: number; active: boolean }>();
    for (const t of tabs) {
      const live = t.id === activeTab;
      const o = live ? order : t.order;
      const ls = live ? lines : t.lines;
      if (o?.type === "dine_in" && o.table) m.set(o.table, { items: ls.length, totalMinor: cartTotals(priceCart(ls, offers, new Date()).lines, live ? invoiceDiscount : t.invoiceDiscount).total, active: live });
    }
    return m;
  }, [tabs, activeTab, order, lines, offers, invoiceDiscount]);

  /** Pay: in an exchange the returned piece's value pays first, and only the difference is asked for. */
  function startPay() {
    if (!lines.length || !shift) return;
    if (lines.some((l) => l.rx) && !prescription) return setDialog({ kind: "rx" });
    if (exchange && totals.total <= exchange.creditMinor) return void pay([{ method: "cash", amountMinor: totals.total }]);
    setDialog({ kind: "pay" });
  }

  /** The customer changed their mind: the exchange becomes a plain return, paid back in cash. */
  function cancelExchange() {
    if (!exchange) return;
    if (!confirm(`نلغي التبديل؟ رجّع للزبون ${formatMoney(exchange.creditMinor)} كاش.`)) return;
    setLastPaid({ number: exchange.number, changeMinor: exchange.creditMinor });
    setExchange(null);
    focusScan();
  }

  async function customerPaid(c: CatalogCustomer, amountMinor: number, method: "cash" | "card") {
    if (!device) return;
    const at = new Date().toISOString();
    await db.sales.put({
      id: crypto.randomUUID(), number: "تسديد", shiftId: shift?.id ?? null, createdAt: at, totalMinor: 0,
      cashInMinor: method === "cash" ? amountMinor : 0, changeMinor: 0, cashierName, input: null, kind: "payment",
    });
    const store = await getMeta<{ footer?: string }>("store");
    setReceipt({ storeName: device.storeName, shop, footer: store?.footer, deviceName: device.name, cashierName, payment: { customerName: c.name, amountMinor, method, balanceMinor: c.balanceMinor, at } });
    if (customer?.id === c.id) setCustomer(c);
    setDialog(null);
    flash(`تم تسديد ${formatMoney(amountMinor)}`);
    focusScan();
  }

  async function hold() {
    if (!lines.length) return;
    await db.held.put({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), label: `${lines.length} أصناف · ${formatMoney(totals.total)}`, lines });
    finishCart();
    flash("تم تعليق الفاتورة");
    focusScan();
  }

  async function openShift(cashMinor: number) {
    const s: LocalShift = { id: crypto.randomUUID(), openedAt: new Date().toISOString(), openingCashMinor: cashMinor, cashierName };
    await db.transaction("rw", db.shifts, db.outbox, async () => {
      await db.shifts.put(s);
      await db.outbox.add({ kind: "shift_open", refId: s.id, payload: { id: s.id, openingCashMinor: cashMinor, openedAt: s.openedAt }, createdAt: s.openedAt });
    });
    setShift(s);
    setDialog(null);
    void syncNow();
    focusScan();
  }

  async function askCloseShift() {
    if (!shift) return;
    const sales = await db.sales.where("shiftId").equals(shift.id).toArray();
    const expected = shift.openingCashMinor + sales.reduce((a, s) => a + s.cashInMinor - s.changeMinor, 0);
    setDialog({ kind: "closeShift", expected });
  }

  async function closeShift(countedMinor: number, expected: number) {
    if (!shift) return;
    const closedAt = new Date().toISOString();
    await db.transaction("rw", db.shifts, db.outbox, async () => {
      await db.shifts.update(shift.id, { closedAt });
      await db.outbox.add({ kind: "shift_close", refId: shift.id, payload: { shiftId: shift.id, closingCashMinor: countedMinor }, createdAt: closedAt });
    });
    // The Z report: printed and shown, worked out from this till's own record of the shift.
    const sales = await db.sales.where("shiftId").equals(shift.id).toArray();
    const z = shiftReport(shift, sales, countedMinor, closedAt);
    z.expectedCashMinor = expected;
    const store = await getMeta<{ footer?: string }>("store");
    const data: ReceiptData = { storeName: device?.storeName ?? "", shop, footer: store?.footer, deviceName: device?.name ?? "", cashierName, shift: z };
    setShift(null);
    setDialog({ kind: "zreport", data });
    if (till.autoPrint ?? true) void print(data, false);
    void syncNow();
  }

  function logout() {
    session.staffToken = null;
    go("pin");
  }

  /** Moves the selection up or down the cart. */
  const step = (d: 1 | -1) => {
    if (!lines.length) return;
    const i = lines.findIndex((l) => l.key === selected);
    const next = i < 0 ? (d > 0 ? 0 : lines.length - 1) : Math.min(lines.length - 1, Math.max(0, i + d));
    setSelected(lines[next].key);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog) return;
      const inScan = document.activeElement === scanRef.current;
      const fn: Record<string, () => void> = {
        F1: () => setDialog({ kind: "keys" }),
        F2: focusScan,
        F3: () => setDialog({ kind: "customer" }),
        F4: () => selected && setDialog({ kind: "qty", key: selected }),
        F5: () => selected && canOverride && setDialog({ kind: "price", key: selected }),
        F6: () => lines.length && maxDiscount > 0 && setDialog({ kind: "discount" }),
        F7: () => receipt && void print({ ...receipt, copy: true }, false),
        F8: () => void hold(),
        F9: () => void db.held.toArray().then((carts) => setDialog({ kind: "held", carts })),
        F10: () => shift && setDialog({ kind: "return" }),
        F11: () => void drawer(),
        F12: startPay,
      };
      if (e.ctrlKey && !e.altKey && /^(Digit|Numpad)[1-9]$/.test(e.code)) {
        // Ctrl+1 … Ctrl+9: the quick keys on screen, in order.
        e.preventDefault();
        const hit = visibleKeys(quick.keys, quickProducts, qGroup)[Number(e.code.slice(-1)) - 1];
        if (hit && !dialog) pressKey(hit.k, hit.p);
      } else if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault();
        const t = tabs[Number(e.code.slice(5)) - 1];
        if (t) switchTab(t.id);
      } else if (e.altKey && e.code === "KeyN") {
        e.preventDefault();
        newTab();
      } else if (restaurant && e.altKey && e.code === "KeyT") {
        e.preventDefault();
        setDialog({ kind: "tables" });
      } else if (restaurant && e.altKey && e.code === "KeyK") {
        e.preventDefault();
        if (pendingKitchen.length) void sendKitchen();
      } else if (restaurant && e.altKey && e.code === "KeyM") {
        e.preventDefault();
        if (selected) setDialog({ kind: "note", key: selected });
      } else if (e.altKey && e.code === "KeyD") {
        e.preventDefault();
        if (shift) setDialog({ kind: "drawer" });
      } else if (fn[e.key]) {
        e.preventDefault();
        fn[e.key]();
      } else if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        fn.F12();
      } else if (e.key === "Delete" && e.ctrlKey) {
        e.preventDefault();
        voidCart();
      } else if (e.key === "ArrowDown" && !results.length) {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowUp" && !results.length) {
        e.preventDefault();
        step(-1);
      } else if (e.key === "Escape") {
        setCode("");
        setResults([]);
        focusScan();
      } else if (e.key === "Delete" && selected && !(inScan && code)) {
        removeLine(selected);
      } else if (e.key === "+" && selected && (!inScan || !code)) {
        e.preventDefault();
        changeQty(selected, 1000);
      } else if (e.key === "-" && selected && (!inScan || !code)) {
        e.preventDefault();
        changeQty(selected, -1000);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const selectedLine = lines.find((l) => l.key === selected);
  // Only shops with medicines (scientific names) get the alternatives key.
  const [hasGeneric, setHasGeneric] = useState(false);
  useEffect(() => void db.products.filter((p) => !!p.genericName).first().then((p) => setHasGeneric(!!p)), [catalogSize, sync?.lastSync]);
  const boss = role === "owner" || role === "manager";
  const canOverride = boss || till.cashierPriceChange;
  /** The biggest invoice discount this person may give, in percent of the bill. */
  const maxDiscount = boss ? 100 : till.cashierMaxDiscountPct;

  return (
    <div className="pos">
      <header className="pos-top">
        <b>{device?.storeName}</b>
        <span>{device?.name}</span>
        <span>· {cashierName}</span>
        <span className="spacer" />
        <button onClick={() => setDialog({ kind: "prefs" })} title="حجم الخط والوضع الليلي والصوت">🎨 العرض</button>
        <button onClick={() => void openCustomerDisplay()} title="افتحها على الشاشة الثانية">شاشة الزبون</button>
        <button onClick={() => setDialog({ kind: "printer" })}>الطابعة والميزان</button>
        <button onClick={() => void syncNow()}>مزامنة</button>
        <button onClick={() => setDialog({ kind: "mypay" })}>💼 راتبي</button>
        <button onClick={askCloseShift} disabled={!shift}>قفل الوردية</button>
        <button onClick={logout}>خروج</button>
      </header>
      <div className="pos-status" role="status">
        {sync ? (
          <span className={`st ${sync.online ? "ok" : "off"}`}><i />{sync.online ? "متصل" : "بدون إنترنت، البيع شغال عادي"}</span>
        ) : <span className="st"><i />…</span>}
        <span className={sync && sync.pending > 0 ? "st warn" : "st"}>{sync && sync.pending > 0 ? `⏳ ${sync.pending} تستنى المزامنة` : "✓ كل شي متزامن"}</span>
        {sync && sync.failed > 0 && <span className="st bad">⚠️ {sync.failed} مرفوضة</span>}
        <span className="st">🧾 مبيعاتك اليوم: <b className="num">{mine.count}</b> فاتورة · <b className="num">{formatMoney(mine.totalMinor)}</b></span>
        {shift && <span className="st">⏱ الوردية من {hhmm(new Date(shift.openedAt))}</span>}
        <span className="spacer" />
        <span className="st muted">{catalogSize} صنف</span>
        <span className="st num">{hhmm(now)}</span>
      </div>

      <main className="pos-main">
        <section className="pos-left">
          <div className="scan">
            <input
              ref={scanRef}
              autoFocus
              placeholder="امسح الباركود أو اكتب اسم الصنف  (3*باركود = 3 حبات)"
              value={code}
              onChange={(e) => void onType(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (results.length && !/^\d+$/.test(code)) pick(results[activeResult]);
                  else void scan(code);
                } else if (e.key === "ArrowDown" && results.length) {
                  e.preventDefault();
                  setActiveResult((i) => Math.min(i + 1, results.length - 1));
                } else if (e.key === "ArrowUp" && results.length) {
                  e.preventDefault();
                  setActiveResult((i) => Math.max(i - 1, 0));
                } else if (e.key === "Escape") {
                  setResults([]);
                  setCode("");
                }
              }}
            />
            {hasCamera() && <button className="scan-cam" onClick={() => setDialog({ kind: "camera" })} title="امسح بالكاميرا" aria-label="امسح بالكاميرا">📷</button>}
            {results.length > 0 && (
              <div className="results">
                {results.map((p, i) => (
                  <button key={p.id} className={i === activeResult ? "active" : ""} onClick={() => pick(p)}>
                    <span>{p.variants ? <>{variantBaseName(p)} <small className="muted">👕 {p.variants} مقاس ولون</small></> : p.name}{p.rx && " 💊"}{p.genericName && <small className="muted"> · {p.genericName}</small>}{p.isWeighted && " ⚖️"}</span>
                    <span className="num">{formatMoney((p.units.find((u) => u.isBase) ?? p.units[0]).priceMinor)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {quick.keys.length > 0 && prefs.quickPlace !== "bottom" && (
            <QuickPad groups={quick.groups} keys={quick.keys} products={quickProducts} group={qGroup} setGroup={setQGroup} size={prefs.quickSize} onPress={pressKey} />
          )}

          {restaurant && <OrderBar order={order} setType={setOrderType} pickTable={() => setDialog({ kind: "tables" })} pending={pendingKitchen.length} onKitchen={() => void sendKitchen()} />}
          <div className="till-tabs" role="tablist" aria-label="الزبائن المفتوحين">
            {tabs.map((t, i) => {
              const live = t.id === activeTab;
              const n = live ? lines.length : t.lines.length;
              const total = live ? totals.total : cartTotals(priceCart(t.lines, offers, new Date()).lines, t.invoiceDiscount).total;
              return (
                <button key={t.id} role="tab" aria-selected={live} className={live ? "active" : ""} onClick={() => switchTab(t.id)} title={`Alt+${i + 1}`}>
                  <span>{(live ? customer : t.customer)?.name ?? (restaurant ? `${ORDER_TYPE_ICONS[(live ? order : t.order ?? DEFAULT_ORDER).type]} ${orderLabel(live ? order : t.order ?? DEFAULT_ORDER, t.n)}` : `زبون ${t.n}`)}</span>
                  {n > 0 && <small className="num">{n} · {formatMoney(total, "")}</small>}
                </button>
              );
            })}
            <button className="ghost" onClick={() => newTab()} title="Alt+N">{restaurant ? "+ طلب جديد" : "+ زبون جديد"}</button>
          </div>

          <div className="cart">
            {lines.length === 0 ? (
              <div className="empty">
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: "3rem" }}>🛒</div>
                  <div>امسح أول صنف</div>
                  {message && <div className={message.bad ? "error" : "badge ok"} style={{ marginTop: 12 }}>{message.text}</div>}
                </div>
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>الصنف</th>
                    <th>الكمية</th>
                    <th>السعر</th>
                    <th>الإجمالي</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {priced.lines.map((l, i) => (
                    <tr key={l.key} className={l.key === selected ? "sel" : ""} onClick={() => setSelected(l.key)}>
                      <td className="num">{i + 1}</td>
                      <td>
                        {l.name}
                        {l.units && (
                          <div className="unit-pick" role="group" aria-label="العبوة">
                            {l.units.map((u) => (
                              <button key={u.id} type="button" className={u.id === l.unitId ? "active" : ""} disabled={!u.priceMinor && u.id !== l.unitId}
                                title={u.priceMinor ? formatMoney(u.priceMinor) : "ما عندهاش سعر"}
                                onClick={(e) => { e.stopPropagation(); setLines((ls) => ls.map((x) => (x.key === l.key ? switchUnit(x, u.id) : x))); setSelected(l.key); }}>{u.name}</button>
                            ))}
                          </div>
                        )}
                        {l.note && <div className="line-note">📝 {l.note}</div>}
                        {restaurant && sent[l.key] && sent[l.key].qtyMilli === l.qtyMilli && (sent[l.key].note || null) === (l.note || null) && <div className="muted small">👨‍🍳 في المطبخ</div>}
                        {l.discountMinor > 0 && <div className="muted">خصم {formatMoney(l.discountMinor)}</div>}
                        {(l.promoMinor ?? 0) > 0 && <div className="offer-tag">🏷 {l.offerName} −{formatMoney(l.promoMinor!)}</div>}
                      </td>
                      <td className="qty">
                        {l.isWeighted ? (
                          <button onClick={() => setDialog({ kind: "qty", key: l.key })} className="num">{formatQty(l.qtyMilli, true)} كغ</button>
                        ) : (
                          <>
                            <button onClick={(e) => { e.stopPropagation(); changeQty(l.key, -1000); }}>−</button>
                            <button className="num" onClick={() => setDialog({ kind: "qty", key: l.key })} style={{ minWidth: 48 }}>{formatQty(l.qtyMilli, false)}</button>
                            <button onClick={(e) => { e.stopPropagation(); changeQty(l.key, 1000); }}>+</button>
                          </>
                        )}
                      </td>
                      <td className="num">{formatMoney(l.priceMinor, "")}</td>
                      <td className="num"><b>{formatMoney(lineTotal(l), "")}</b></td>
                      <td><button className="danger" onClick={(e) => { e.stopPropagation(); removeLine(l.key); }}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {quick.keys.length > 0 && prefs.quickPlace === "bottom" && (
            <QuickPad groups={quick.groups} keys={quick.keys} products={quickProducts} group={qGroup} setGroup={setQGroup} size={prefs.quickSize} onPress={pressKey} />
          )}
        </section>

        <aside className="pos-right">
          <div className="totals">
            <div className="line"><span>عدد الأصناف</span><span className="num">{lines.length}</span></div>
            <div className="line"><span>المجموع</span><span className="num">{formatMoney(totals.subtotal)}</span></div>
            {priced.applied.map((a) => (
              <div className="line offer-tag" key={a.offerId}><span>🏷 {a.name}</span><span className="num">−{formatMoney(a.amountMinor)}</span></div>
            ))}
            {totals.discount > 0 && <div className="line"><span>الخصم</span><span className="num">−{formatMoney(totals.discount)}</span></div>}
            {totals.tax > 0 && <div className="line muted"><span>منها ضريبة</span><span className="num">{formatMoney(totals.tax)}</span></div>}
            {exchange && (
              <>
                <div className="line exchange-tag"><span>🔁 تبديل <small className="num">({exchange.number})</small></span><span className="num">−{formatMoney(exchange.creditMinor)}</span></div>
                {totals.total < exchange.creditMinor && lines.length > 0 && <div className="line"><span>يرجع للزبون</span><span className="num">{formatMoney(exchange.creditMinor - totals.total)}</span></div>}
              </>
            )}
            <div className="grand num">{formatMoney(exchange ? Math.max(0, totals.total - exchange.creditMinor) : totals.total)}</div>
            {exchange && <button className="ghost" onClick={cancelExchange}>إلغاء التبديل ورجّع الفلوس</button>}
            {lastPaid && (
              <div className={`change-big ${lastPaid.changeMinor ? "" : "done"}`} onClick={() => setLastPaid(null)}>
                <span>{lastPaid.changeMinor ? `الباقي للزبون · ${lastPaid.number}` : `✓ تم البيع · ${lastPaid.number}`}</span>
                {!!lastPaid.changeMinor && <b className="num">{formatMoney(lastPaid.changeMinor)}</b>}
              </div>
            )}
            {lines.some((l) => l.rx) && (
              <button className="ghost rx-box" onClick={() => setDialog({ kind: "rx" })}>
                💊 {prescription ? `الوصفة: ${[prescription.doctor && `د. ${prescription.doctor}`, prescription.number && `رقم ${prescription.number}`].filter(Boolean).join(" · ") || "تم التأكيد"}` : "فيه دواء بوصفة: سجّل الوصفة"}
              </button>
            )}
            {customer && <CustomerBox c={customer} rules={rules} onClear={() => setCustomer(null)} />}
            {message && lines.length > 0 && <div className={message.bad ? "error" : "badge ok"} style={{ textAlign: "center" }}>{message.text}</div>}
            {receipt?.sale && !lines.length && (shop?.settings.whatsapp.offerAfterSale ?? true) && (
              <button className="wa-offer" onClick={() => setDialog({ kind: "wa" })}>
                <span>📲</span> أرسل الفاتورة {receipt.sale.number} على الواتساب{receipt.customerName ? ` لـ${receipt.customerName}` : ""}
              </button>
            )}
          </div>
          <div className="keys">
            <button onClick={() => selected && setDialog({ kind: "qty", key: selected })} disabled={!selected}>الكمية <kbd>F4</kbd></button>
            <button onClick={() => selected && setDialog({ kind: "price", key: selected })} disabled={!selected || !canOverride}>تعديل السعر <kbd>F5</kbd></button>
            <button onClick={() => setDialog({ kind: "discount" })} disabled={!lines.length || maxDiscount <= 0}>خصم على الفاتورة <kbd>F6</kbd></button>
            <button onClick={() => selectedLine && removeLine(selectedLine.key)} disabled={!selected} className="danger">حذف الصنف <kbd>Del</kbd></button>
            {hasGeneric && <button onClick={() => void showAlternatives()} disabled={!selected}>💊 البدائل</button>}
            {restaurant && <button onClick={() => selected && setDialog({ kind: "note", key: selected })} disabled={!selected}>📝 ملاحظة <kbd>Alt+M</kbd></button>}
            <button onClick={hold} disabled={!lines.length}>تعليق <kbd>F8</kbd></button>
            <button onClick={async () => setDialog({ kind: "held", carts: await db.held.toArray() })}>الفواتير المعلقة <kbd>F9</kbd></button>
            <button onClick={() => setDialog({ kind: "customer" })}>{customer ? `العميل: ${customer.name}` : "العميل / تسديد"} <kbd>F3</kbd></button>
            <button onClick={() => setDialog({ kind: "return" })} disabled={!shift}>مرتجع <kbd>F10</kbd></button>
            <button onClick={() => receipt && void print({ ...receipt, copy: true }, false)} disabled={!receipt}>إعادة طباعة <kbd>F7</kbd></button>
            <button onClick={() => void drawer()}>فتح الدرج <kbd>F11</kbd></button>
            <button onClick={() => setDialog({ kind: "drawer" })} disabled={!shift}>💵 إيداع / سحب <kbd>Alt+D</kbd></button>
            <button onClick={voidCart} disabled={!lines.length} className="danger">إلغاء الفاتورة</button>
            <button onClick={() => setDialog({ kind: "keys" })} className="ghost">⌨️ الاختصارات <kbd>F1</kbd></button>
            <button className="primary pay" disabled={!lines.length || !shift} onClick={startPay}>
              دفع <kbd>F12</kbd>
            </button>
          </div>
        </aside>
      </main>

      <Receipt data={slip ?? receipt} />
      {dialog?.kind === "tables" && <TablesDialog tables={tables} busy={busyTables} onPick={pickTable} onClose={() => { setDialog(null); focusScan(); }} />}
      {dialog?.kind === "note" && (
        <NoteDialog
          name={lines.find((l) => l.key === dialog.key)?.name ?? ""}
          initial={lines.find((l) => l.key === dialog.key)?.note ?? ""}
          onClose={() => { setDialog(null); focusScan(); }}
          onDone={(note) => { setLines((ls) => ls.map((l) => (l.key === dialog.key ? { ...l, note: note || null } : l))); setDialog(null); focusScan(); }}
        />
      )}

      {dialog?.kind === "printer" && <PrinterDialog onClose={() => { setDialog(null); focusScan(); }} />}
      {dialog?.kind === "mypay" && (
        <Modal title="راتبي" onClose={() => { setDialog(null); focusScan(); }}>
          <div className="mypay-modal"><MyPay token={session.staffToken} /></div>
          <div className="row"><span className="spacer" /><button onClick={() => { setDialog(null); focusScan(); }}>إغلاق</button></div>
        </Modal>
      )}
      {dialog?.kind === "pay" && <PayDialog totalMinor={exchange ? totals.total - exchange.creditMinor : totals.total} customer={customer} employees={employees} rules={rules} onPay={exchange ? (ps, emp) => pay(withCredit(ps, exchange.creditMinor), emp) : pay} onClose={() => { setDialog(null); focusScan(); }} />}
      {dialog?.kind === "weight" && (
        <AmountDialog
          title={dialog.product.name}
          label="الوزن (كغ)"
          scale
          onClose={() => { setDialog(null); focusScan(); }}
          onDone={(milli) => {
            if (milli > 0) put(lineFor(dialog.product, dialog.product.units.find((u) => u.isBase)!, milli));
            setDialog(null);
            focusScan();
          }}
        />
      )}
      {dialog?.kind === "qty" && (
        <AmountDialog
          title="الكمية"
          label={lines.find((l) => l.key === dialog.key)?.isWeighted ? "الوزن (كغ)" : "العدد"}
          initial={String((lines.find((l) => l.key === dialog.key)?.qtyMilli ?? 1000) / 1000)}
          scale={lines.find((l) => l.key === dialog.key)?.isWeighted}
          onClose={() => { setDialog(null); focusScan(); }}
          onDone={(milli) => {
            setLines((ls) => (milli <= 0 ? ls.filter((l) => l.key !== dialog.key) : ls.map((l) => (l.key === dialog.key ? { ...l, qtyMilli: milli } : l))));
            setDialog(null);
            focusScan();
          }}
        />
      )}
      {dialog?.kind === "price" && (
        <AmountDialog
          title={dialog.open ? `«${lines.find((l) => l.key === dialog.key)?.name ?? ""}» بكم؟` : dialog.required ? `«${lines.find((l) => l.key === dialog.key)?.name ?? ""}» ما عندهش سعر` : "تعديل السعر"}
          label="سعر البيع (د.ل)"
          initial={dialog.required ? "" : String((lines.find((l) => l.key === dialog.key)?.priceMinor ?? 0) / 1000)}
          onClose={() => {
            // Closed without a price: the line can't stay at zero.
            if (dialog.required) setLines((ls) => ls.filter((l) => l.key !== dialog.key || l.priceMinor > 0));
            setDialog(null);
            focusScan();
          }}
          onDone={(m) => {
            setLines((ls) => (dialog.required && m <= 0 ? ls.filter((l) => l.key !== dialog.key) : ls.map((l) => (l.key === dialog.key ? { ...l, priceMinor: m } : l))));
            setDialog(null);
            focusScan();
          }}
        />
      )}
      {dialog?.kind === "wa" && receipt?.sale && (
        <WaDialog
          initial={receipt.customerPhone ?? ""}
          onClose={() => { setDialog(null); focusScan(); }}
          onSend={(phone) => {
            sendInvoice({ shopName: shop?.name ?? device?.storeName ?? "", settings: shop?.settings, saleId: receipt.sale!.id, number: receipt.sale!.number, totalMinor: receipt.sale!.totalMinor, phone });
            setDialog(null);
            focusScan();
          }}
        />
      )}
      {dialog?.kind === "keys" && (
        <Modal title="⌨️ اختصارات لوحة المفاتيح" onClose={() => { setDialog(null); focusScan(); }}>
          <div className="keys-help">
            {KEYS.map(([k, what]) => <div key={k}><kbd>{k}</kbd><span>{what}</span></div>)}
          </div>
          <div className="row"><span className="spacer" /><button className="primary" onClick={() => { setDialog(null); focusScan(); }}>تمام</button></div>
        </Modal>
      )}
      {dialog?.kind === "discount" && (
        <AmountDialog
          title="خصم على الفاتورة"
          label="قيمة الخصم (د.ل)"
          initial={String(invoiceDiscount / 1000)}
          onClose={() => { setDialog(null); focusScan(); }}
          onDone={(m) => {
            const base = totals.subtotal - totals.lineDiscount;
            const cap = Math.floor((base * maxDiscount) / 100);
            if (m > cap) flash(`أقصى خصم مسموح لك ${maxDiscount}% (${formatMoney(cap)})`, true);
            setInvoiceDiscount(Math.min(m, cap));
            setDialog(null);
            focusScan();
          }}
        />
      )}
      {dialog?.kind === "openShift" && (
        <AmountDialog
          title="فتح وردية"
          label="الكاش الموجود في الدرج (د.ل)"
          initial="0"
          onClose={() => setDialog(null)}
          onDone={(m) => void openShift(m)}
        />
      )}
      {dialog?.kind === "zreport" && (
        <Modal title="تقرير قفل الوردية" onClose={logout}>
          <div className="zreport"><Receipt data={dialog.data} preview /></div>
          <div className="row">
            <button onClick={() => void print({ ...dialog.data, copy: true }, false)}>🖨️ اطبعه</button>
            <span className="spacer" />
            <button className="primary" onClick={logout}>تم، خروج</button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "drawer" && <DrawerDialog onDone={(k, m, r) => void drawerMove(k, m, r)} onClose={() => { setDialog(null); focusScan(); }} />}
      {dialog?.kind === "rx" && (
        <RxDialog initial={prescription} items={lines.filter((l) => l.rx).map((l) => l.name)}
          onSave={(p) => { setPrescription(p); setDialog(null); focusScan(); }}
          onRemove={() => { setLines((ls) => ls.filter((l) => !l.rx)); setSelected(null); setDialog(null); flash("شلنا الأدوية اللي تحتاج وصفة"); focusScan(); }}
          onClose={() => { setDialog(null); focusScan(); }} />
      )}
      {dialog?.kind === "variant" && (
        <VariantPicker groupId={dialog.groupId} onClose={() => { setDialog(null); focusScan(); }}
          onPick={(p) => { const times = dialog.times; setDialog(null); pick(p, times); }} />
      )}
      {dialog?.kind === "prefs" && (
        <Modal title="🎨 شكل الشاشة" onClose={() => { setDialog(null); focusScan(); }}>
          <span className="muted">يتحفظ لك أنت ({cashierName}) على هذا الجهاز، وكل كاشير يختار اللي يريحه.</span>
          <label>حجم الخط
            <div className="seg">
              {([["md", "عادي"], ["lg", "كبير"], ["xl", "كبير جداً"]] as const).map(([k, t]) => (
                <button key={k} className={prefs.size === k ? "active" : ""} onClick={() => { const p = { ...prefs, size: k }; setPrefs(p); savePrefs(p); }}>{t}</button>
              ))}
            </div>
          </label>
          <label>الألوان
            <div className="seg">
              <button className={!prefs.dark ? "active" : ""} onClick={() => { const p = { ...prefs, dark: false }; setPrefs(p); savePrefs(p); }}>☀️ نهاري</button>
              <button className={prefs.dark ? "active" : ""} onClick={() => { const p = { ...prefs, dark: true }; setPrefs(p); savePrefs(p); }}>🌙 ليلي</button>
            </div>
          </label>
          <label>الصوت
            <div className="seg">
              <button className={prefs.sound ? "active" : ""} onClick={() => { const p = { ...prefs, sound: true }; setPrefs(p); savePrefs(p); sound("ok"); }}>🔊 بيب مع كل مسحة</button>
              <button className={!prefs.sound ? "active" : ""} onClick={() => { const p = { ...prefs, sound: false }; setPrefs(p); savePrefs(p); }}>🔇 بدون صوت</button>
            </div>
          </label>
          <label>الأزرار السريعة
            <div className="seg">
              {([["sm", "صغيرة"], ["md", "عادية"], ["lg", "كبيرة (لمس)"]] as const).map(([k, t]) => (
                <button key={k} className={prefs.quickSize === k ? "active" : ""} onClick={() => { const p = { ...prefs, quickSize: k }; setPrefs(p); savePrefs(p); }}>{t}</button>
              ))}
            </div>
            <div className="seg">
              <button className={prefs.quickPlace !== "bottom" ? "active" : ""} onClick={() => { const p = { ...prefs, quickPlace: "top" as const }; setPrefs(p); savePrefs(p); }}>⬆️ فوق السلة</button>
              <button className={prefs.quickPlace === "bottom" ? "active" : ""} onClick={() => { const p = { ...prefs, quickPlace: "bottom" as const }; setPrefs(p); savePrefs(p); }}>⬇️ تحت السلة</button>
            </div>
          </label>
          {restaurant && (
            <label>ورقة المطبخ
              <div className="seg">
                <button className={prefs.kitchenSlip ? "active" : ""} onClick={() => { const p = { ...prefs, kitchenSlip: true }; setPrefs(p); savePrefs(p); }}>🖨️ تنطبع مع كل إرسال</button>
                <button className={!prefs.kitchenSlip ? "active" : ""} onClick={() => { const p = { ...prefs, kitchenSlip: false }; setPrefs(p); savePrefs(p); }}>📺 شاشة المطبخ بس</button>
              </div>
            </label>
          )}
          <div className="row"><button onClick={() => sound("bad")}>جرّب صوت الخطأ</button><span className="spacer" /><button className="primary" onClick={() => { setDialog(null); focusScan(); }}>تمام</button></div>
        </Modal>
      )}
      {dialog?.kind === "camera" && (
        <CameraScanner onClose={() => { setDialog(null); focusScan(); }} onCode={(c) => { setDialog(null); void scan(c); focusScan(); }} />
      )}
      {dialog?.kind === "closeShift" && (
        <AmountDialog
          title="قفل الوردية"
          label="عدّ الكاش الموجود في الدرج (د.ل)"
          onClose={() => setDialog(null)}
          onDone={(m) => void closeShift(m, dialog.expected)}
        />
      )}
      {dialog?.kind === "customer" && (
        <CustomerDialog
          current={customer}
          shiftId={shift?.id ?? null}
          onPick={(c) => { pickCustomer(c); setDialog(null); focusScan(); }}
          onPaid={customerPaid}
          onClose={() => { setDialog(null); focusScan(); }}
        />
      )}
      {dialog?.kind === "return" && device && (
        <ReturnDialog shiftId={shift?.id ?? null} newNumber={() => nextInvoiceNumber(device.prefix)} onDone={returnDone} onClose={() => { setDialog(null); focusScan(); }} />
      )}
      {dialog?.kind === "held" && (
        <Modal title="الفواتير المعلقة" onClose={() => setDialog(null)}>
          {dialog.carts.length === 0 && <p className="muted">ما فيش فواتير معلقة</p>}
          {dialog.carts.map((c) => (
            <div key={c.id} className="row">
              <span>{c.label}</span>
              <span className="muted num">{new Date(c.createdAt).toLocaleTimeString("en-GB")}</span>
              <span className="spacer" />
              <button
                className="primary"
                onClick={async () => {
                  // A customer is already being served: the held bill opens in its own tab.
                  if (lines.length) {
                    const cur = current();
                    const t = { ...emptyTab(Math.max(...tabs.map((x) => x.n)) + 1), lines: c.lines as CartLine[] };
                    setTabs((ts) => [...ts.map((x) => (x.id === activeTab ? cur : x)), t]);
                    setActiveTab(t.id);
                    loadTab(t);
                  } else setLines(c.lines as CartLine[]);
                  await db.held.delete(c.id);
                  setDialog(null);
                  focusScan();
                }}
              >
                استرجاع
              </button>
              <button className="danger" onClick={async () => { await db.held.delete(c.id); setDialog({ kind: "held", carts: await db.held.toArray() }); }}>حذف</button>
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}


/** The customer on the bill: what they owe, their limit, and a warning as they get close to it. */
/** The returned piece's value joins the cash the customer hands over, as one cash payment. */
function withCredit(ps: { method: PaymentMethod; amountMinor: number }[], creditMinor: number) {
  const cash = ps.find((p) => p.method === "cash");
  return cash ? ps.map((p) => (p === cash ? { ...p, amountMinor: p.amountMinor + creditMinor } : p)) : [{ method: "cash" as const, amountMinor: creditMinor }, ...ps];
}

function CustomerBox({ c, rules, onClear }: { c: CatalogCustomer; rules: LoyaltySettings | null; onClear: () => void }) {
  const room = creditRoom(c);
  const limit = c.creditLimitMinor;
  const pct = limit ? Math.min(100, Math.round((c.balanceMinor / limit) * 100)) : 0;
  const level = limit === null || limit <= 0 ? "" : c.balanceMinor >= limit ? "over" : pct >= 80 ? "near" : "";
  return (
    <div className={`cust-box ${level}`}>
      <div className="cust-head"><b>👤 {c.name}</b>{c.phone && <span className="muted num">{c.phone}</span>}<button className="ghost" onClick={onClear} aria-label="شيل العميل">✕</button></div>
      <div className="line"><span>عليه دين</span><b className="num">{formatMoney(c.balanceMinor)}</b></div>
      {rules?.enabled && <div className="line"><span>⭐ نقاطه</span><span><b className="num">{c.points ?? 0}</b> <span className="muted num">({formatMoney((c.points ?? 0) * rules.pointValueMinor)})</span></span></div>}
      {limit !== null && limit > 0 && <>
        <div className="line"><span>حد الدين</span><span className="num">{formatMoney(limit)}</span></div>
        <div className="cust-bar"><i style={{ width: `${pct}%` }} /></div>
        <div className="line"><span>{level === "over" ? "⛔ وصل الحد، ما يقدرش يشري بالآجل" : level === "near" ? "⚠️ قرّب من الحد" : "يقدر ياخذ بالآجل"}</span><b className="num">{formatMoney(room ?? 0)}</b></div>
      </>}
    </div>
  );
}

/** Asks the customer's WhatsApp number (or leaves it empty to pick the chat in WhatsApp). */
function WaDialog({ initial, onSend, onClose }: { initial: string; onSend: (phone: string) => void; onClose: () => void }) {
  const [phone, setPhone] = useState(initial);
  return (
    <Modal title="📲 إرسال الفاتورة على الواتساب" onClose={onClose}>
      <label>
        رقم واتساب الزبون
        <input className="num" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="09xxxxxxxx" autoFocus
          onKeyDown={(e) => e.key === "Enter" && onSend(phone)} />
      </label>
      <div className="muted">الواتساب يفتح والرسالة مكتوبة فيها رابط الفاتورة، وانت تضغط إرسال. لو تخليه فاضي تختار المحادثة من الواتساب.</div>
      <div className="row"><span className="spacer" /><button onClick={onClose}>إلغاء</button><button className="primary" onClick={() => onSend(phone)}>فتح الواتساب</button></div>
    </Modal>
  );
}

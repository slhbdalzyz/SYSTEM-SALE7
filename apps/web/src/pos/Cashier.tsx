import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { creditRoom, formatMoney, shiftSettingsSchema, waLink, LAYOUT_SPECS, FUNCTION_KEYS, TILL_ACTION_LABELS, keyMap, keyOf, pickLayout, pickStructure, tillButtons, type TillBlock, TILL_THEMES, THEME_INFO, type DisplayAds, tillLayoutSchema, toMinor, type TillAction, type TillButton, formatQty, pointsEarned, pointsFor, readShopSettings, shopModules, type CustomerTier, type CatalogCustomer, type CatalogProduct, type LoyaltySettings, type Offer, type PaymentMethod, type QuickGroup, type QuickKey, type ShopSettings, expiryState, variantBaseName, type Prescription, kitchenDelta, sentSnapshot, ORDER_TYPE_LABELS, ORDER_TYPE_ICONS, type OrderType, type SentLine, serialsMissing } from "@pos/shared";
import { api } from "../api";
import { db, getMeta, nextInvoiceNumber, setMeta, type HeldCart, type LocalShift } from "../localdb";
import { alternatives, findByCode, searchProducts, type Found } from "../lookup";
import { VariantPicker } from "./VariantPicker";
import { RxDialog } from "./RxDialog";
import { SerialDialog } from "./SerialDialog";
import { session, tokenClaims } from "../session";
import { SHIFT_CLOSED, loadExpiry, loadOffers, loadTables, onSync, refreshCounts, startSyncLoop, syncNow, type DiningTable, type SyncState } from "../sync";
import { NoteDialog, OrderBar, TablesDialog, type Order } from "./restaurant";
import { autoBackupIfDue } from "../owner/backup";
import type { Screen } from "../App";
import { addLine, cartTotals, lineFor, lineTotal, priceCart, repriceFor, switchUnit, toSaleInput, type CartLine, type Deal } from "./cart";
import { DealBox, DealDialog, KitDialog, QuoteDialog, loadKits, tierLabel } from "./business";
import { AmountDialog, DrawerDialog, Modal, PayDialog, type Employee, type Payment, type TillBank } from "./dialogs";
import { applyPrefs, loadPrefs, preloadSaleSound, saleSound, savePrefs, scanSound, sound, type TillPrefs } from "./feel";
import { MyPay } from "../admin/MyPay";
import { Receipt, type ReceiptData } from "./Receipt";
import { CustomerDialog } from "./CustomerDialog";
import { ReturnDialog, type ReturnDone } from "./ReturnDialog";
import { PrinterDialog } from "../hardware/PrinterDialog";
import { openCustomerDisplay, openDrawer, printReceipt } from "../hardware/printer";
import { displaySender } from "../display/channel";
import { sendInvoice } from "../whatsapp";
import { nonCash, shiftReport, zText } from "./shiftReport";
import { CloseShiftDialog, type CloseResult, type OpenThings } from "./closeShift";
import { ProductGrid } from "./ProductGrid";
import { printPage } from "../hardware/pageInvoice";
import { loadPrinterSettings } from "../hardware/printer";
import { CameraScanner, hasCamera } from "../hardware/CameraScanner";
import { QuickPad, visibleKeys } from "./quickpad";
import { LoanDialog } from "./loans";
import type { LoanMoveKind } from "../localdb";

type Dialog =
  | { kind: "pay" }
  | { kind: "weight"; product: CatalogProduct }
  | { kind: "qty"; key: string }
  | { kind: "price"; key: string; required?: boolean; open?: boolean }
  | { kind: "discount" }
  | { kind: "openShift" }
  | { kind: "closeShift"; expected: number; card: number; transfer: number; open: OpenThings }
  | { kind: "held"; carts: HeldCart[] }
  | { kind: "customer" }
  | { kind: "return" }
  | { kind: "printer" }
  | { kind: "mypay" }
  | { kind: "keys" }
  | { kind: "wa" }
  | { kind: "zreport"; data: ReceiptData; wa?: string }
  | { kind: "xreport"; data: ReceiptData }
  | { kind: "camera" }
  | { kind: "drawer" }
  | { kind: "loans" }
  | { kind: "prefs" }
  | { kind: "variant"; groupId: string; times: number }
  | { kind: "rx" }
  | { kind: "serial"; key: string; paying?: boolean }
  | { kind: "tables" }
  | { kind: "note"; key: string }
  | { kind: "quote" }
  | { kind: "kit" }
  | { kind: "deal" }
  | null;

/** A customer being served. Several can be open at once, one tab each. */
interface Tab {
  id: string; n: number; lines: CartLine[]; invoiceDiscount: number; customer: CatalogCustomer | null; selected: string | null; prescription?: Prescription | null;
  /** Restaurants: how the order goes out, and what the kitchen has already been told. */
  order?: Order | null; sent?: Record<string, SentLine>;
  /** The quote it came from, the building site, a delivery. */
  deal?: Deal;
}
const emptyTab = (n: number, order: Order | null = null): Tab => ({ id: crypto.randomUUID(), n, lines: [], invoiceDiscount: 0, customer: null, selected: null, prescription: null, order, sent: {} });
const DEFAULT_ORDER: Order = { type: "takeaway" };
const today = () => new Date().toLocaleDateString("en-CA");
const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

type Shop = { name: string; settings: ShopSettings; type?: string; banks?: TillBank[] };

/** The till's keyboard: what each key does, shown on F1. */
const KEYS: [string, string][] = [
  ["Ctrl+Enter", "الدفع"],
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
  const [deal, setDeal] = useState<Deal>({});
  /** Whether this shop has ready-made lists, to show the key only then. */
  const [hasKits, setHasKits] = useState(false);
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
  const shiftSet = shop?.settings?.shift ?? shiftSettingsSchema.parse({});
  // The screen's layout: the cashier's, else this till's, else the shop's (set by the owner).
  const layoutSet = shop?.settings?.tillLayout ?? tillLayoutSchema.parse({});
  const me = tokenClaims(session.staffToken);
  const layout = pickLayout(layoutSet, shop?.type, me?.did, me?.sub);
  const spec = LAYOUT_SPECS[layout];
  const frame = useMemo(() => pickStructure(layoutSet, me?.did, me?.sub), [layoutSet, me?.did, me?.sub]);
  const [moreKeys, setMoreKeys] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const bigTotal = layoutSet.bigTotal ?? spec.bigTotal;
  const keysOn = useMemo(() => keyMap(layoutSet), [layoutSet]);
  const kbd = (a: TillAction) => keyOf(layoutSet, a);
  // The till follows the shop's features (🧩 مميزات المحل): tables and kitchen, quotes, delivery, kits, price tiers.
  const mods = useMemo(() => shopModules(shop?.type, shop?.settings.modules), [shop]);
  const restaurant = mods.tables;
  const tierOf = (c: { priceTier?: CustomerTier | null } | null | undefined) => (mods.tiers ? c?.priceTier ?? null : null);
  const scanRef = useRef<HTMLInputElement>(null);
  const device = session.device;
  const [prefs, setPrefs] = useState<TillPrefs>(loadPrefs);
  useEffect(() => applyPrefs(prefs, layoutSet.theme), [prefs, layoutSet.theme]);
  const [tabs, setTabs] = useState<Tab[]>(() => [emptyTab(1)]);
  /** Change the last shift on this till left in the drawer (when the shop hands over the drawer). */
  const [handoverFloat, setHandoverFloat] = useState<number | null>(null);
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
  useEffect(() => preloadSaleSound(), []);
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

  // The owner closed this shift from the dashboard, or the shop's closing hour passed.
  useEffect(() => {
    const on = () => {
      setShift(null);
      setDialog({ kind: "openShift" });
      flash("الوردية تقفلت من عند المالك. افتح وردية جديدة باش تكمّل البيع", true);
    };
    window.addEventListener(SHIFT_CLOSED, on);
    return () => window.removeEventListener(SHIFT_CLOSED, on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    startSyncLoop();
    const off = onSync(setSync);
    (async () => {
      setCashierName((await getMeta<string>("staffName")) ?? "");
      const open = (await db.shifts.toArray()).find((s) => !s.closedAt) ?? null;
      setShift(open);
      setHandoverFloat((await getMeta<number | null>("float")) ?? null);
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
        const me = await api<{ tenant: { name: string; settings: unknown; loyalty?: LoyaltySettings; business_type?: string }; stores: { id: string; receipt_footer: string | null }[]; storeId: string; banks?: TillBank[] }>("/me", { token: session.staffToken });
        await setMeta("store", { footer: me.stores.find((s) => s.id === me.storeId)?.receipt_footer });
        // The shop's name and settings: what the receipt shows and what a cashier may do.
        const next = { name: me.tenant.name, settings: readShopSettings(me.tenant.settings), type: me.tenant.business_type, banks: me.banks ?? [] };
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
  useEffect(() => void loadKits().then((k) => setHasKits(k.length > 0)), [sync?.lastSync]);

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
    // The shop's slides for between sales: the copy kept here first, then the server's.
    void (async () => {
      const send = (a: DisplayAds) => d.ads({ kind: "ads", ...a });
      const kept = await getMeta<DisplayAds>("displayAds");
      if (kept) send(kept);
      try {
        const fresh = await api<DisplayAds>("/settings/display-ads", { token: session.staffToken });
        await setMeta("displayAds", fresh);
        send(fresh);
      } catch {
        /* offline: the slides kept last time */
      }
    })();
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
    // A contractor, wholesale or workshop customer pays their own price for the unit.
    line = repriceFor([line], null, tierOf(customer))[0];
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
    // A phone sold by its own number: the same number twice is the same phone.
    if (line.serials?.length && lines.some((l) => l.serials?.some((x) => line.serials!.includes(x)))) return flash(`الجهاز ${line.serials[0]} موجود في الفاتورة`, true);
    const r = addLine(lines, line);
    setLines(r.lines);
    setSelected(r.key);
    scanSound(line.isWeighted ? "weighed" : isNew ? "new" : "again", prefs.scanSound, prefs.sound);
    setLastPaid(null);
    // Its number was not scanned: ask for it now, while the box is in the cashier's hand.
    const added = r.lines.find((l) => l.key === r.key);
    if (added?.serialized && !added.noSerial && serialsMissing(added) > 0) setTimeout(() => setDialog({ kind: "serial", key: r.key }), 0);
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
      if (hit.serial) put({ ...lineFor(hit.product, hit.unit, 1000), serials: [hit.serial] });
      else if (hit.qtyMilli) put(lineFor(hit.product, hit.unit, hit.qtyMilli));
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
    // Fewer phones: the last numbers scanned come off with them.
    setLines((ls) => ls.flatMap((l) => (l.key !== key ? [l] : l.qtyMilli + delta <= 0 ? [] : [{ ...l, qtyMilli: l.qtyMilli + delta, ...(l.serials ? { serials: l.serials.slice(0, Math.max(0, Math.round((l.qtyMilli + delta) / 1000))) } : {}) }])));
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
    // The owner sees cancelled carts in «🕵️ الخصومات والمرتجعات والإلغاء».
    const at = new Date().toISOString();
    const id = crypto.randomUUID();
    void db.outbox.add({ kind: "void", refId: id, payload: { id, at, totalMinor: totals.total, lines: lines.length, items: lines.map((l) => l.name).join("، ").slice(0, 500) }, createdAt: at });
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
    setDeal({});
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
    setDeal(t.deal ?? {});
  }
  const current = (): Tab => ({ ...(tabs.find((t) => t.id === activeTab) ?? emptyTab(1)), lines, invoiceDiscount, customer, selected, prescription, order, sent, deal });
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
  }, [tabs, activeTab, lines, invoiceDiscount, customer, order, sent, deal]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /** A loan or deposit moved cash: kept for the shift (the server records the drawer move itself). */
  async function loanMove(loan: LoanMoveKind, amountMinor: number, reason: string) {
    const at = new Date().toISOString();
    const into = loan === "loan_back" || loan === "deposit_in";
    await db.sales.put({ id: crypto.randomUUID(), number: into ? "إيداع" : "سحب", shiftId: shift?.id ?? null, createdAt: at, totalMinor: 0, cashInMinor: into ? amountMinor : -amountMinor, changeMinor: 0, cashierName, input: null, kind: "drawer", reason, loan });
    void openDrawer().catch(() => undefined);
    void syncNow();
  }

  function pickCustomer(c: CatalogCustomer | null) {
    const from = tierOf(customer), to = tierOf(c);
    if (from !== to) setLines((ls) => repriceFor(ls, from, to));
    setCustomer(c);
    if (c && c.creditLimitMinor !== null && c.creditLimitMinor > 0 && c.balanceMinor >= c.creditLimitMinor * 0.8) {
      flash(c.balanceMinor >= c.creditLimitMinor ? `⛔ ${c.name} وصل حد الدين` : `⚠️ ${c.name} قرّب من حد الدين`, true);
    }
  }

  async function pay(payments: Payment[], employeeId: string | null = null) {
    if (!device) return;
    // Whatever the kitchen has not heard of yet goes now, so nothing paid for is left unmade.
    if (restaurant && pendingKitchen.length) await sendKitchen();
    const id = crypto.randomUUID();
    const number = await nextInvoiceNumber(device.prefix);
    const sale = toSaleInput({ id, number, shiftId: shift?.id ?? null, lines, offers, invoiceDiscountMinor: invoiceDiscount, payments, customerId: customer?.id, employeeId, prescription: lines.some((l) => l.rx) ? prescription : null, deal,
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
    saleSound(prefs.sound);
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
    const key = p?.partNumber || p?.genericName;
    if (!p || !key) return flash(p ? "الصنف هذا ما عندهش اسم علمي ولا رقم قطعة" : "اختار صنف", true);
    const alts = await alternatives(p);
    if (!alts.length) return flash(`ما فيش بدائل لـ«${key}»`, true);
    setResults(alts);
    setActiveResult(0);
    flash(`بدائل ${key}: ${alts.length}`);
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
    const noNumber = lines.find((l) => l.serialized && !l.noSerial && serialsMissing(l) > 0);
    if (noNumber) return setDialog({ kind: "serial", key: noNumber.key, paying: true });
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
    const { card, transfer } = nonCash(shiftReport(shift, sales, 0).byMethod);
    const open: OpenThings = {
      held: await db.held.count(),
      tabs: tabs.filter((t) => (t.id === activeTab ? lines.length : t.lines.length) > 0).length,
      tables: busyTables.size,
      pending: sync?.pending ?? 0,
      failed: sync?.failed ?? 0,
    };
    setDialog({ kind: "closeShift", expected, card, transfer, open });
  }

  /** The shift so far, printed without closing it (X report). */
  async function xReport() {
    if (!shift) return;
    const sales = await db.sales.where("shiftId").equals(shift.id).toArray();
    const z = shiftReport(shift, sales, 0);
    z.x = true;
    const store = await getMeta<{ footer?: string }>("store");
    setDialog({ kind: "xreport", data: { storeName: device?.storeName ?? "", shop, footer: store?.footer, deviceName: device?.name ?? "", cashierName, shift: z } });
  }

  async function closeShift(r: CloseResult, expected: number, card: number, transfer: number) {
    if (!shift) return;
    const closedAt = new Date().toISOString();
    await db.transaction("rw", db.shifts, db.outbox, async () => {
      await db.shifts.update(shift.id, { closedAt });
      await db.outbox.add({
        kind: "shift_close", refId: shift.id, createdAt: closedAt,
        payload: { shiftId: shift.id, closingCashMinor: r.countedMinor, notes: r.notes, cardCountedMinor: r.cardMinor, transferCountedMinor: r.transferMinor, floatMinor: r.floatMinor, reason: r.reason },
      });
    });
    // The next shift on this till opens with the change left in the drawer.
    await setMeta("float", r.floatMinor);
    // The Z report: printed and shown, worked out from this till's own record of the shift.
    const sales = await db.sales.where("shiftId").equals(shift.id).toArray();
    const z = shiftReport(shift, sales, r.countedMinor, closedAt);
    z.expectedCashMinor = expected;
    Object.assign(z, {
      notes: r.notes, floatMinor: r.floatMinor, reason: r.reason, approvedBy: r.approvedBy,
      card: r.cardMinor === null ? null : { counted: r.cardMinor, expected: card },
      transfer: r.transferMinor === null ? null : { counted: r.transferMinor, expected: transfer },
    });
    const store = await getMeta<{ footer?: string }>("store");
    const data: ReceiptData = { storeName: device?.storeName ?? "", shop, footer: store?.footer, deviceName: device?.name ?? "", cashierName, shift: { ...z, blind: shiftSet.blind } };
    // The owner's copy on WhatsApp always shows the difference.
    const wa = shiftSet.whatsappZ ? waLink(shiftSet.whatsappPhone || shop?.settings.phone || null, zText(z, { shop: shop?.name ?? "", device: device?.name ?? "", cashier: cashierName })) : undefined;
    setShift(null);
    setDialog({ kind: "zreport", data, wa });
    if (till.autoPrint ?? true) void print(data, false);
    if (wa) window.open(wa, "_blank", "noopener");
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
      const act: Record<TillAction, () => void> = {
        help: () => setDialog({ kind: "keys" }),
        search: focusScan,
        customer: () => setDialog({ kind: "customer" }),
        qty: () => selected && setDialog({ kind: "qty", key: selected }),
        price: () => selected && canOverride && setDialog({ kind: "price", key: selected }),
        discount: () => lines.length && maxDiscount > 0 && setDialog({ kind: "discount" }),
        reprint: () => receipt && void print({ ...receipt, copy: true }, false),
        hold: () => void hold(),
        held: () => void db.held.toArray().then((carts) => setDialog({ kind: "held", carts })),
        return: () => shift && setDialog({ kind: "return" }),
        drawerOpen: () => void drawer(),
        pay: startPay,
      };
      // F1…F12, as the owner set them.
      const fn: Record<string, () => void> = Object.fromEntries(Object.entries(keysOn).map(([k, a]) => [k, act[a]]));
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
        act.pay();
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
  useEffect(() => void db.products.filter((p) => !!p.genericName || !!p.partNumber).first().then((p) => setHasGeneric(!!p)), [catalogSize, sync?.lastSync]);
  const boss = role === "owner" || role === "manager";
  const canOverride = boss || till.cashierPriceChange;
  /** The biggest invoice discount this person may give, in percent of the bill. */
  const maxDiscount = boss ? 100 : till.cashierMaxDiscountPct;

  /** One tap: the bill paid in cash with exactly this much; the receipt prints and the bill clears. */
  function fastCash(amountMinor: number) {
    if (!lines.length || !shift) return;
    if (lines.some((l) => l.rx) && !prescription) return setDialog({ kind: "rx" });
    if (lines.some((l) => l.serialized && !l.noSerial && serialsMissing(l) > 0)) return startPay();
    void pay([{ method: "cash", amountMinor }]);
  }

  /** The last bill on an A4 (or A5) sheet, for a contractor or a company. */
  function printA4() {
    if (!receipt) return;
    const p = loadPrinterSettings();
    void printPage({ ...receipt, copy: true }, { size: p.sheet === "A5" ? "A5" : "A4", textScale: p.textScale, marginMm: p.marginMm });
  }

  /** The cashier's buttons, by id, so the owner can choose and order them. */
  function buttonFor(b: TillButton) {
    switch (b) {
      case "qty": return <button key={b} onClick={() => selected && setDialog({ kind: "qty", key: selected })} disabled={!selected}>الكمية <kbd>{kbd("qty")}</kbd></button>;
      case "price": return <button key={b} onClick={() => selected && setDialog({ kind: "price", key: selected })} disabled={!selected || !canOverride}>تعديل السعر <kbd>{kbd("price")}</kbd></button>;
      case "discount": return <button key={b} onClick={() => setDialog({ kind: "discount" })} disabled={!lines.length || maxDiscount <= 0}>خصم على الفاتورة <kbd>{kbd("discount")}</kbd></button>;
      case "remove": return <button key={b} onClick={() => selectedLine && removeLine(selectedLine.key)} disabled={!selected} className="danger">حذف الصنف <kbd>Del</kbd></button>;
      case "alternatives": return hasGeneric ? <button key={b} onClick={() => void showAlternatives()} disabled={!selected}>{shop?.type === "auto_parts" ? "🔁 البدائل" : "💊 البدائل"}</button> : null;
      case "quote": return mods.quotes ? <button key={b} onClick={() => setDialog({ kind: "quote" })}>📄 عرض سعر</button> : null;
      case "deal": return mods.delivery ? <button key={b} onClick={() => setDialog({ kind: "deal" })}>🏗️ مشروع / 🚚 توصيل</button> : null;
      case "kit": return hasKits && mods.kits ? <button key={b} onClick={() => setDialog({ kind: "kit" })}>🎒 قائمة جاهزة</button> : null;
      case "note": return restaurant || selectedLine?.service || layout === "tech" ? <button key={b} onClick={() => selected && setDialog({ kind: "note", key: selected })} disabled={!selected}>📝 ملاحظة{restaurant && <> <kbd>Alt+M</kbd></>}</button> : null;
      case "hold": return <button key={b} onClick={hold} disabled={!lines.length}>تعليق <kbd>{kbd("hold")}</kbd></button>;
      case "held": return <button key={b} onClick={async () => setDialog({ kind: "held", carts: await db.held.toArray() })}>الفواتير المعلقة <kbd>{kbd("held")}</kbd></button>;
      case "customer": return <button key={b} onClick={() => setDialog({ kind: "customer" })}>{customer ? `العميل: ${customer.name}` : "العميل / تسديد"} <kbd>{kbd("customer")}</kbd></button>;
      case "return": return <button key={b} onClick={() => setDialog({ kind: "return" })} disabled={!shift}>مرتجع <kbd>{kbd("return")}</kbd></button>;
      case "reprint": return <button key={b} onClick={() => receipt && void print({ ...receipt, copy: true }, false)} disabled={!receipt}>إعادة طباعة <kbd>{kbd("reprint")}</kbd></button>;
      case "a4": return <button key={b} onClick={printA4} disabled={!receipt?.sale}>🖨 فاتورة A4</button>;
      case "drawerOpen": return <button key={b} onClick={() => void drawer()}>فتح الدرج <kbd>{kbd("drawerOpen")}</kbd></button>;
      case "loans": return mods.loans ? <button key={b} onClick={() => setDialog({ kind: "loans" })} disabled={!shift}>🤝 سلف وأمانات</button> : null;
      case "drawerMove": return <button key={b} onClick={() => setDialog({ kind: "drawer" })} disabled={!shift}>💵 إيداع / سحب <kbd>Alt+D</kbd></button>;
      case "void": return <button key={b} onClick={voidCart} disabled={!lines.length} className="danger">إلغاء الفاتورة</button>;
      case "keys": return <button key={b} onClick={() => setDialog({ kind: "keys" })} className="ghost">⌨️ الاختصارات <kbd>{kbd("help")}</kbd></button>;
    }
  }

  const grand = exchange ? Math.max(0, totals.total - exchange.creditMinor) : totals.total;
  const btns = tillButtons(layoutSet, layout).map((b) => buttonFor(b)).filter(Boolean);
  const short = frame.collapseKeys && !moreKeys && btns.length > 5;
  /** The screen's parts, placed by the frame the owner picked. */
  const blocks: Record<TillBlock, ReactNode> = {
    scan: (
      <>
          <div className="scan">
            <input
              ref={scanRef}
              autoFocus
              placeholder={spec.placeholder ?? "امسح الباركود أو اكتب اسم الصنف  (3*باركود = 3 حبات)"}
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
                    <span>{p.variants ? <>{variantBaseName(p)} <small className="muted">👕 {p.variants} مقاس ولون</small></> : p.name}{p.rx && " 💊"}{p.isService && <small className="muted"> 🛠️ خدمة</small>}{p.genericName && <small className="muted"> · {p.genericName}</small>}{p.partNumber && <small className="muted num"> · {p.partNumber}</small>}{p.fits && <small className="muted"> · 🚗 {p.fits}</small>}{p.location && <small className="muted"> · 📍 {p.location}</small>}{p.isWeighted && " ⚖️"}</span>
                    <span className="num">{formatMoney((p.units.find((u) => u.isBase) ?? p.units[0]).priceMinor)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {spec.customerFirst && !customer && (
            <button className="customer-first" onClick={() => setDialog({ kind: "customer" })}>👤 اختار العميل أولاً (سعر الجملة والدين والفاتورة باسمه) <kbd>{kbd("customer")}</kbd></button>
          )}
      </>
    ),
    grid: spec.grid || frame.showGrid ? <ProductGrid onPick={(p) => pick(p)} big={spec.touch || frame.sheet} side={frame.sideCats} /> : null,
    quick: quick.keys.length > 0 ? (
            <QuickPad groups={quick.groups} keys={quick.keys} products={quickProducts} group={qGroup} setGroup={setQGroup} size={prefs.quickSize} onPress={pressKey} />
    ) : null,
    tabs: (
      <>
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
      </>
    ),
    cart: (
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
                                onClick={(e) => { e.stopPropagation(); setLines((ls) => ls.map((x) => (x.key === l.key ? switchUnit(x, u.id, tierOf(customer)) : x))); setSelected(l.key); }}>{u.name}</button>
                            ))}
                          </div>
                        )}
                        {l.note && <div className="line-note">📝 {l.note}</div>}
                        {l.serialized && (
                          <button type="button" className="ghost small serial-tag" onClick={(e) => { e.stopPropagation(); setDialog({ kind: "serial", key: l.key }); }}>
                            📱 {l.serials?.length ? l.serials.join("، ") : l.noSerial ? "بدون رقم" : "امسح رقم الجهاز"}{serialsMissing(l) > 0 && l.serials?.length ? ` (ناقص ${serialsMissing(l)})` : ""}
                          </button>
                        )}
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
    ),
    totals: (
      <>
          {bigTotal && (
            <div className="big-total" aria-live="polite">
              <span className="num">{formatMoney(exchange ? Math.max(0, totals.total - exchange.creditMinor) : totals.total)}</span>
              <small>{lines.length} صنف · {formatQty(lines.reduce((a, l) => a + l.qtyMilli, 0), false)} قطعة{lastPaid?.changeMinor ? ` · الباقي ${formatMoney(lastPaid.changeMinor)}` : ""}</small>
            </div>
          )}
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
            {spec.fastCash && !exchange && lines.length > 0 && shift && (
              <div className="fast-cash" role="group" aria-label="دفع كاش سريع">
                <button className="primary" onClick={() => fastCash(totals.total)}>💵 كاش بالضبط</button>
                {layoutSet.cashNotes.map((n) => toMinor(n)).filter((m) => m > totals.total).map((m) => (
                  <button key={m} onClick={() => fastCash(m)} className="num">{formatMoney(m, "")}</button>
                ))}
              </div>
            )}
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
            {customer && <CustomerBox c={customer} rules={rules} onClear={() => pickCustomer(null)} />}
            <DealBox deal={deal} onEdit={() => setDialog({ kind: "deal" })} onClearQuote={() => setDeal((d) => ({ ...d, quoteId: null, quoteNumber: null }))} />
            {message && lines.length > 0 && <div className={message.bad ? "error" : "badge ok"} style={{ textAlign: "center" }}>{message.text}</div>}
            {receipt?.sale && !lines.length && (shop?.settings.whatsapp.offerAfterSale ?? true) && (
              <button className="wa-offer" onClick={() => setDialog({ kind: "wa" })}>
                <span>📲</span> أرسل الفاتورة {receipt.sale.number} على الواتساب{receipt.customerName ? ` لـ${receipt.customerName}` : ""}
              </button>
            )}
          </div>
      </>
    ),
    keys: (
      <div className="keys">
        {short ? btns.slice(0, 4) : btns}
        {frame.collapseKeys && btns.length > 5 && (
          <button className="ghost more-keys" onClick={() => setMoreKeys((m) => !m)}>{short ? `⋯ المزيد (${btns.length - 4})` : "▲ أقل"}</button>
        )}
        <button className="primary pay" disabled={!lines.length || !shift} onClick={startPay}>
          دفع <kbd>{kbd("pay")}</kbd>
        </button>
      </div>
    ),
  };
  // The quick buttons go under the cart when the cashier asked for them there.
  const placed = (list: TillBlock[]) => {
    if (prefs.quickPlace !== "bottom" || !list.includes("quick") || !list.includes("cart")) return list;
    const rest: TillBlock[] = list.filter((b) => b !== "quick");
    rest.splice(rest.indexOf("cart") + 1, 0, "quick");
    return rest;
  };
  const zone = (list: TillBlock[]) => placed(list).map((b) => <Fragment key={b}>{blocks[b]}</Fragment>);

  return (
    <div className={`pos layout-${layout}${spec.touch ? " touch" : ""}${bigTotal ? " bigtotal" : ""}`}>
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
        {shiftSet.xReport && <button onClick={() => void xReport()} disabled={!shift} title="حالة الوردية لين توا، من غير قفل">📄 تقرير X</button>}
        <button onClick={() => void askCloseShift()} disabled={!shift}>قفل الوردية</button>
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

      <main className={`pos-main frame-${frame.id}${frame.bottom.length ? (frame.sheet ? " has-sheet" : " has-bottom") : ""}`} style={{ "--cols": frame.cols.map((c) => c.w).join(" ") } as CSSProperties}>
        {frame.cols.map((c, i) => (
          <section key={i} className="zone">{zone(c.blocks)}</section>
        ))}
        {frame.bottom.length > 0 && !frame.sheet && <section className="zone bottom">{zone(frame.bottom)}</section>}
        {frame.bottom.length > 0 && frame.sheet && (
          <section className={`zone sheet${sheetOpen ? " open" : ""}`} aria-label="السلة والدفع">
            <div className="sheet-bar">
              <button className="sheet-handle" onClick={() => setSheetOpen((o) => !o)} aria-expanded={sheetOpen}>
                {sheetOpen ? "▼" : "▲"} 🛒 <span className="num">{lines.length}</span> صنف · <b className="num">{formatMoney(grand)}</b>
              </button>
              {!sheetOpen && <button className="primary pay" disabled={!lines.length || !shift} onClick={startPay}>دفع</button>}
            </div>
            {sheetOpen && <div className="sheet-body">{zone(frame.bottom)}</div>}
          </section>
        )}
      </main>

      <Receipt data={slip ?? receipt} />
      {dialog?.kind === "tables" && <TablesDialog tables={tables} busy={busyTables} onPick={pickTable} onClose={() => { setDialog(null); focusScan(); }} />}
      {dialog?.kind === "note" && (
        <NoteDialog
          name={lines.find((l) => l.key === dialog.key)?.name ?? ""}
          initial={lines.find((l) => l.key === dialog.key)?.note ?? ""}
          {...(lines.find((l) => l.key === dialog.key)?.service ? { chips: [], placeholder: "مثلاً: تفليش آيفون 11، نسخة iOS 17" } : {})}
          onClose={() => { setDialog(null); focusScan(); }}
          onDone={(note) => { setLines((ls) => ls.map((l) => (l.key === dialog.key ? { ...l, note: note || null } : l))); setDialog(null); focusScan(); }}
        />
      )}

      {dialog?.kind === "quote" && (
        <QuoteDialog lines={priced.lines} customer={customer} deal={deal} shopName={shop?.name ?? device?.storeName ?? ""} shop={{}}
          onClose={() => { setDialog(null); focusScan(); }}
          onOpen={({ quote, lines: ls, customer: c }) => {
            if (lines.length && !confirm("الفاتورة اللي على الشاشة تتبدل بعرض السعر. نكمّل؟")) return;
            setLines(ls); setSelected(null); setInvoiceDiscount(0);
            setCustomer(c);
            setDeal({ quoteId: quote.id, quoteNumber: quote.number, project: quote.project ?? null, delivery: null });
            setDialog(null); flash(`📄 عرض السعر ${quote.number}: ${ls.length} أصناف`); focusScan();
          }} />
      )}
      {dialog?.kind === "kit" && (
        <KitDialog onClose={() => { setDialog(null); focusScan(); }}
          onPick={(ls, name) => { setDialog(null); setLines((cur) => repriceFor(ls, null, tierOf(customer)).reduce((acc, l) => addLine(acc, l).lines, cur)); setLastPaid(null); flash(`🎒 ${name}: ${ls.length} أصناف`); focusScan(); }} />
      )}
      {dialog?.kind === "deal" && (
        <DealDialog deal={deal} customer={customer} onClose={() => { setDialog(null); focusScan(); }} onDone={(d) => { setDeal(d); setDialog(null); focusScan(); }} />
      )}
      {dialog?.kind === "printer" && <PrinterDialog onClose={() => { setDialog(null); focusScan(); }} />}
      {dialog?.kind === "mypay" && (
        <Modal title="راتبي" onClose={() => { setDialog(null); focusScan(); }}>
          <div className="mypay-modal"><MyPay token={session.staffToken} /></div>
          <div className="row"><span className="spacer" /><button onClick={() => { setDialog(null); focusScan(); }}>إغلاق</button></div>
        </Modal>
      )}
      {dialog?.kind === "pay" && <PayDialog totalMinor={exchange ? totals.total - exchange.creditMinor : totals.total} customer={customer} employees={employees} rules={rules} shopMethods={shop?.settings.payMethods} hidden={shop?.settings.hiddenMethods} banks={shop?.banks} onPay={exchange ? (ps, emp) => pay(withCredit(ps, exchange.creditMinor), emp) : pay} onClose={() => { setDialog(null); focusScan(); }} />}
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
            {FUNCTION_KEYS.filter((k) => keysOn[k]).map((k) => <div key={k}><kbd>{k}</kbd><span>{TILL_ACTION_LABELS[keysOn[k]]}</span></div>)}
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
          label={handoverFloat !== null ? `الكاش الموجود في الدرج (د.ل) · الوردية اللي قبلك خلّت ${formatMoney(handoverFloat)}` : "الكاش الموجود في الدرج (د.ل)"}
          initial={handoverFloat !== null ? String(handoverFloat / 1000) : "0"}
          onClose={() => setDialog(null)}
          onDone={(m) => void openShift(m)}
        />
      )}
      {dialog?.kind === "zreport" && (
        <Modal title="تقرير قفل الوردية" onClose={logout}>
          <div className="zreport"><Receipt data={dialog.data} preview /></div>
          <div className="row">
            <button onClick={() => void print({ ...dialog.data, copy: true }, false)}>🖨️ اطبعه</button>
            {dialog.wa && <a className="button" href={dialog.wa} target="_blank" rel="noopener">📲 ابعته على الواتساب</a>}
            <span className="spacer" />
            <button className="primary" onClick={logout}>تم، خروج</button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "xreport" && (
        <Modal title="تقرير X: الوردية لين توا" onClose={() => { setDialog(null); focusScan(); }}>
          <div className="zreport"><Receipt data={dialog.data} preview /></div>
          <div className="row">
            <button onClick={() => void print({ ...dialog.data, copy: true }, false)}>🖨️ اطبعه</button>
            <span className="spacer" />
            <button className="primary" onClick={() => { setDialog(null); focusScan(); }}>رجوع للبيع</button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "loans" && (
        <LoanDialog shiftId={shift?.id ?? null} customer={customer} shop={shop} onMoved={loanMove}
          onPrint={(loan) => void (async () => {
            const data: ReceiptData = { storeName: device?.storeName ?? "", shop, deviceName: device?.name ?? "", cashierName, loan };
            setSlip(data);
            await new Promise((ok) => setTimeout(ok, 60));
            await print(data, false);
            setSlip(null);
          })()}
          onClose={() => { setDialog(null); focusScan(); }} />
      )}
      {dialog?.kind === "drawer" && <DrawerDialog onDone={(k, m, r) => void drawerMove(k, m, r)} onClose={() => { setDialog(null); focusScan(); }} />}
      {dialog?.kind === "rx" && (
        <RxDialog initial={prescription} items={lines.filter((l) => l.rx).map((l) => l.name)}
          onSave={(p) => { setPrescription(p); setDialog(null); focusScan(); }}
          onRemove={() => { setLines((ls) => ls.filter((l) => !l.rx)); setSelected(null); setDialog(null); flash("شلنا الأدوية اللي تحتاج وصفة"); focusScan(); }}
          onClose={() => { setDialog(null); focusScan(); }} />
      )}
      {dialog?.kind === "serial" && (() => {
        const line = lines.find((l) => l.key === dialog.key);
        if (!line) return null;
        const close = () => { setDialog(null); focusScan(); };
        const after = (patch: Partial<CartLine>) => {
          const next = lines.map((l) => (l.key === line.key ? { ...l, ...patch } : l));
          setLines(next);
          setDialog(null);
          // Paying: go on to the next phone without a number, then to the payment.
          if (dialog.paying) {
            const more = next.find((l) => l.serialized && !l.noSerial && serialsMissing(l) > 0);
            if (more) return setDialog({ kind: "serial", key: more.key, paying: true });
            if (exchange) { focusScan(); return flash("كل الأجهزة عليها أرقام، اضغط دفع"); }
            return setDialog({ kind: "pay" });
          }
          focusScan();
        };
        return (
          <SerialDialog line={line} taken={lines.filter((l) => l.key !== line.key).flatMap((l) => l.serials ?? [])} onClose={close}
            onSave={(serials) => after({ serials, noSerial: false })}
            onSkip={() => after({ noSerial: true })} />
        );
      })()}
      {dialog?.kind === "variant" && (
        <VariantPicker groupId={dialog.groupId} onClose={() => { setDialog(null); focusScan(); }}
          onPick={(p) => { const times = dialog.times; setDialog(null); pick(p, times); }} />
      )}
      {dialog?.kind === "prefs" && (
        <Modal title="🎨 شكل الشاشة" onClose={() => { setDialog(null); focusScan(); }}>
          <div className="muted small">الواجهة: {spec.icon} {spec.label} · الهيكل: {frame.icon} {frame.name}. يختارهم المالك من «⚙ الإعدادات ← 🖥 واجهة الكاشير»، وانت تبدّل الشكل بس.</div>
          <span className="muted">يتحفظ لك أنت ({cashierName}) على هذا الجهاز، وكل كاشير يختار اللي يريحه.</span>
          <label>حجم الخط
            <div className="seg">
              {([["md", "عادي"], ["lg", "كبير"], ["xl", "كبير جداً"]] as const).map(([k, t]) => (
                <button key={k} className={prefs.size === k ? "active" : ""} onClick={() => { const p = { ...prefs, size: k }; setPrefs(p); savePrefs(p); }}>{t}</button>
              ))}
            </div>
          </label>
          <label>الألوان
            <div className="theme-picks">
              {(["", ...TILL_THEMES] as const).map((t) => {
                const on = t === "dark" ? prefs.dark || prefs.theme === "dark" : !prefs.dark && prefs.theme === t;
                const info = THEME_INFO[t || layoutSet.theme.name];
                return (
                  <button key={t || "shop"} className={`theme-pick${on ? " active" : ""}`} onClick={() => { const p = { ...prefs, theme: t, dark: false }; setPrefs(p); savePrefs(p); }}>
                    <i style={{ background: `linear-gradient(135deg, ${info.brand} 50%, ${info.bg} 50%)` }} />{t ? (t === "dark" ? "🌙 ليلي" : info.label) : "زي المحل"}
                  </button>
                );
              })}
            </div>
          </label>
          <label>الصوت
            <div className="seg">
              <button className={prefs.sound ? "active" : ""} onClick={() => { const p = { ...prefs, sound: true }; setPrefs(p); savePrefs(p); scanSound("new", p.scanSound); }}>🔊 صوت مع كل مسحة</button>
              <button className={!prefs.sound ? "active" : ""} onClick={() => { const p = { ...prefs, sound: false }; setPrefs(p); savePrefs(p); }}>🔇 بدون صوت</button>
            </div>
            {prefs.sound && (
              <div className="seg">
                <button className={prefs.scanSound !== "beep" ? "active" : ""} onClick={() => { const p = { ...prefs, scanSound: "scanner" as const }; setPrefs(p); savePrefs(p); scanSound("new", "scanner"); }}>📟 صوت الماسح</button>
                <button className={prefs.scanSound === "beep" ? "active" : ""} onClick={() => { const p = { ...prefs, scanSound: "beep" as const }; setPrefs(p); savePrefs(p); scanSound("new", "beep"); }}>🔔 البيب القديم</button>
              </div>
            )}
            {prefs.sound && (
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <button className="small" onClick={() => scanSound("new", prefs.scanSound)}>صنف جديد</button>
                <button className="small" onClick={() => scanSound("again", prefs.scanSound)}>نفس الصنف مرة ثانية</button>
                <button className="small" onClick={() => scanSound("weighed", prefs.scanSound)}>صنف بالوزن</button>
              </div>
            )}
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
          <div className="row"><button onClick={() => sound("bad")}>جرّب صوت الخطأ</button><button onClick={() => saleSound()}>جرّب صوت البيع</button><span className="spacer" /><button className="primary" onClick={() => { setDialog(null); focusScan(); }}>تمام</button></div>
        </Modal>
      )}
      {dialog?.kind === "camera" && (
        <CameraScanner onClose={() => { setDialog(null); focusScan(); }} onCode={(c) => { setDialog(null); void scan(c); focusScan(); }} />
      )}
      {dialog?.kind === "closeShift" && shift && (
        <CloseShiftDialog
          shiftId={shift.id} set={shiftSet} expected={dialog.expected} card={dialog.card} transfer={dialog.transfer} open={dialog.open}
          onClose={() => { setDialog(null); focusScan(); }}
          onDone={(r) => void closeShift(r, dialog.expected, dialog.card, dialog.transfer)}
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
      <div className="cust-head"><b>👤 {c.name}{tierLabel(c) && <span className="tier-tag">{tierLabel(c)}</span>}</b>{c.phone && <span className="muted num">{c.phone}</span>}<button className="ghost" onClick={onClear} aria-label="شيل العميل">✕</button></div>
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

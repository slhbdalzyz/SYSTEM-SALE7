import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMoney, formatQty, readShopSettings, type CatalogCustomer, type CatalogProduct, type Offer, type PaymentMethod, type ShopSettings } from "@pos/shared";
import { api } from "../api";
import { db, getMeta, nextInvoiceNumber, setMeta, type HeldCart, type LocalShift } from "../localdb";
import { findByCode, searchProducts } from "../lookup";
import { session, tokenClaims } from "../session";
import { loadOffers, onSync, refreshCounts, startSyncLoop, syncNow, type SyncState } from "../sync";
import { autoBackupIfDue } from "../owner/backup";
import type { Screen } from "../App";
import { addLine, cartTotals, lineFor, lineTotal, priceCart, switchUnit, toSaleInput, type CartLine } from "./cart";
import { AmountDialog, Modal, PayDialog, type Employee } from "./dialogs";
import { MyPay } from "../admin/MyPay";
import { Receipt, type ReceiptData } from "./Receipt";
import { CustomerDialog } from "./CustomerDialog";
import { ReturnDialog, type ReturnDone } from "./ReturnDialog";
import { PrinterDialog } from "../hardware/PrinterDialog";
import { openCustomerDisplay, openDrawer, printReceipt } from "../hardware/printer";
import { displaySender } from "../display/channel";
import { sendInvoice } from "../whatsapp";

type Dialog =
  | { kind: "pay" }
  | { kind: "weight"; product: CatalogProduct }
  | { kind: "qty"; key: string }
  | { kind: "price"; key: string; required?: boolean }
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
  | null;

type Shop = { name: string; settings: ShopSettings };

/** The till's keyboard: what each key does, shown on F1. */
const KEYS: [string, string][] = [
  ["F1", "هذي القائمة"], ["F2", "خانة الباركود والبحث"], ["F3", "العميل / تسديد دين"], ["F4", "كمية الصنف المختار"],
  ["F5", "تعديل سعر الصنف المختار"], ["F6", "خصم على الفاتورة"], ["F7", "إعادة طباعة آخر فاتورة"], ["F8", "تعليق الفاتورة"],
  ["F9", "الفواتير المعلقة"], ["F10", "مرتجع"], ["F11", "فتح الدرج"], ["F12 / Ctrl+Enter", "الدفع"],
  ["↑ ↓", "التنقل بين أصناف الفاتورة"], ["+ / −", "زيادة أو نقص كمية الصنف المختار"], ["Delete", "حذف الصنف المختار"],
  ["Ctrl+Delete", "إلغاء الفاتورة كلها"], ["3*باركود", "يبيع 3 من نفس الصنف"], ["Esc", "يقفل النافذة أو يمسح البحث"],
];

export function Cashier({ go }: { go: (s: Screen) => void }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [invoiceDiscount, setInvoiceDiscount] = useState(0);
  const [code, setCode] = useState("");
  const [results, setResults] = useState<CatalogProduct[]>([]);
  const [activeResult, setActiveResult] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [shift, setShift] = useState<LocalShift | null>(null);
  const [cashierName, setCashierName] = useState("");
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [catalogSize, setCatalogSize] = useState(0);
  const [customer, setCustomer] = useState<CatalogCustomer | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shop, setShop] = useState<Shop | null>(null);
  const till = (shop?.settings ?? readShopSettings({})).till;
  const scanRef = useRef<HTMLInputElement>(null);
  const device = session.device;
  const role = tokenClaims(session.staffToken)?.role;

  const [offers, setOffers] = useState<Offer[]>([]);
  // Offers can start or end while a cart is open, so the clock is part of the price.
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const t = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => void loadOffers().then(setOffers), [sync?.lastSync]);
  const priced = useMemo(() => priceCart(lines, offers, new Date()), [lines, offers, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const totals = useMemo(() => cartTotals(priced.lines, invoiceDiscount), [priced, invoiceDiscount]);

  const focusScan = useCallback(() => setTimeout(() => scanRef.current?.focus(), 0), []);
  const flash = (text: string, bad = false) => {
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
      try {
        const me = await api<{ tenant: { name: string; settings: unknown }; stores: { id: string; receipt_footer: string | null }[]; storeId: string }>("/me", { token: session.staffToken });
        await setMeta("store", { footer: me.stores.find((s) => s.id === me.storeId)?.receipt_footer });
        // The shop's name and settings: what the receipt shows and what a cashier may do.
        const next = { name: me.tenant.name, settings: readShopSettings(me.tenant.settings) };
        await setMeta("shop", next);
        setShop(next);
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

  function pick(p: CatalogProduct, times = 1) {
    setResults([]);
    setCode("");
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
    if (!lines.length) return;
    if (till.confirmClear && !confirm(`نلغي الفاتورة (${lines.length} أصناف · ${formatMoney(totals.total)})؟`)) return;
    clearCart();
    flash("تم إلغاء الفاتورة");
    focusScan();
  }

  function clearCart() {
    setLines([]);
    setInvoiceDiscount(0);
    setSelected(null);
    setCustomer(null);
  }

  async function pay(payments: { method: PaymentMethod; amountMinor: number }[], employeeId: string | null = null) {
    if (!device) return;
    const id = crypto.randomUUID();
    const number = await nextInvoiceNumber(device.prefix);
    const sale = toSaleInput({ id, number, shiftId: shift?.id ?? null, lines, offers, invoiceDiscountMinor: invoiceDiscount, payments, customerId: customer?.id, employeeId });
    const credit = payments.filter((p) => p.method === "credit").reduce((a, p) => a + p.amountMinor, 0);
    const paid = payments.reduce((a, p) => a + p.amountMinor, 0);
    const change = paid - sale.totalMinor;
    const cashIn = payments.filter((p) => p.method === "cash").reduce((a, p) => a + p.amountMinor, 0);
    // Saved on the device first, so a sale is never lost if the internet or the server is down.
    await db.transaction("rw", db.sales, db.outbox, async () => {
      await db.sales.put({ id, number, shiftId: sale.shiftId ?? null, createdAt: sale.createdAt, totalMinor: sale.totalMinor, cashInMinor: cashIn, changeMinor: change, cashierName, input: sale });
      await db.outbox.add({ kind: "sale", refId: id, payload: sale, createdAt: sale.createdAt });
    });
    // Until the next sync, count the new debt locally so the credit limit still holds offline.
    if (customer && credit > 0) await db.customers.update(customer.id, { balanceMinor: customer.balanceMinor + credit });
    const store = await getMeta<{ footer?: string }>("store");
    setReceipt({ storeName: device.storeName, shop, footer: store?.footer, deviceName: device.name, cashierName, sale, changeMinor: change, customerName: customer?.name, customerPhone: customer?.phone, employeeName: employees.find((e) => e.id === employeeId)?.name });
    clearCart();
    setDialog(null);
    flash(change > 0 ? `الباقي ${formatMoney(change)}` : "تم البيع");
    await refreshCounts();
    void syncNow();
    focusScan();
  }

  async function returnDone(r: ReturnDone) {
    if (!device) return;
    await db.sales.put({
      id: crypto.randomUUID(), number: r.number, shiftId: shift?.id ?? null, createdAt: new Date().toISOString(), totalMinor: -r.totalMinor,
      cashInMinor: r.method === "cash" ? -r.totalMinor : 0, changeMinor: 0, cashierName, input: null, kind: "return",
    });
    const store = await getMeta<{ footer?: string }>("store");
    setReceipt({ storeName: device.storeName, shop, footer: store?.footer, deviceName: device.name, cashierName, ret: r });
    setDialog(null);
    flash(r.method === "cash" ? `رجّع للزبون ${formatMoney(r.totalMinor)} كاش` : "تم المرتجع");
    void syncNow();
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
    clearCart();
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
    const diff = countedMinor - expected;
    alert(`تم قفل الوردية.\nالمتوقع: ${formatMoney(expected)}\nالموجود: ${formatMoney(countedMinor)}\nالفرق: ${formatMoney(diff)}`);
    await syncNow();
    logout();
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
        F12: () => lines.length && shift && setDialog({ kind: "pay" }),
      };
      if (fn[e.key]) {
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
        {sync && (
          <span className={`badge ${sync.failed ? "bad" : sync.online ? "ok" : "off"}`}>
            {sync.online ? "متصل" : "بدون إنترنت"}
            {sync.pending > 0 && ` · ${sync.pending} بانتظار الإرسال`}
            {sync.failed > 0 && ` · ${sync.failed} مرفوضة`}
          </span>
        )}
        <span className="muted">{catalogSize} صنف</span>
        <button onClick={() => void openCustomerDisplay()} title="افتحها على الشاشة الثانية">شاشة الزبون</button>
        <button onClick={() => setDialog({ kind: "printer" })}>الطابعة والميزان</button>
        <button onClick={() => void syncNow()}>مزامنة</button>
        <button onClick={() => setDialog({ kind: "mypay" })}>💼 راتبي</button>
        <button onClick={askCloseShift} disabled={!shift}>قفل الوردية</button>
        <button onClick={logout}>خروج</button>
      </header>

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
            {results.length > 0 && (
              <div className="results">
                {results.map((p, i) => (
                  <button key={p.id} className={i === activeResult ? "active" : ""} onClick={() => pick(p)}>
                    <span>{p.name}{p.isWeighted && " ⚖️"}</span>
                    <span className="num">{formatMoney((p.units.find((u) => u.isBase) ?? p.units[0]).priceMinor)}</span>
                  </button>
                ))}
              </div>
            )}
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
            <div className="grand num">{formatMoney(totals.total)}</div>
            {customer && (
              <div className="line" style={{ background: "var(--brand-soft)", padding: "6px 10px", borderRadius: 8 }}>
                <span>👤 {customer.name}</span>
                <span className="num">الرصيد {formatMoney(customer.balanceMinor)}</span>
              </div>
            )}
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
            <button onClick={hold} disabled={!lines.length}>تعليق <kbd>F8</kbd></button>
            <button onClick={async () => setDialog({ kind: "held", carts: await db.held.toArray() })}>الفواتير المعلقة <kbd>F9</kbd></button>
            <button onClick={() => setDialog({ kind: "customer" })}>{customer ? `العميل: ${customer.name}` : "العميل / تسديد"} <kbd>F3</kbd></button>
            <button onClick={() => setDialog({ kind: "return" })} disabled={!shift}>مرتجع <kbd>F10</kbd></button>
            <button onClick={() => receipt && void print({ ...receipt, copy: true }, false)} disabled={!receipt}>إعادة طباعة <kbd>F7</kbd></button>
            <button onClick={() => void drawer()}>فتح الدرج <kbd>F11</kbd></button>
            <button onClick={voidCart} disabled={!lines.length} className="danger">إلغاء الفاتورة</button>
            <button onClick={() => setDialog({ kind: "keys" })} className="ghost">⌨️ الاختصارات <kbd>F1</kbd></button>
            <button className="primary pay" disabled={!lines.length || !shift} onClick={() => setDialog({ kind: "pay" })}>
              دفع <kbd>F12</kbd>
            </button>
          </div>
        </aside>
      </main>

      <Receipt data={receipt} />

      {dialog?.kind === "printer" && <PrinterDialog onClose={() => { setDialog(null); focusScan(); }} />}
      {dialog?.kind === "mypay" && (
        <Modal title="راتبي" onClose={() => { setDialog(null); focusScan(); }}>
          <div className="mypay-modal"><MyPay token={session.staffToken} /></div>
          <div className="row"><span className="spacer" /><button onClick={() => { setDialog(null); focusScan(); }}>إغلاق</button></div>
        </Modal>
      )}
      {dialog?.kind === "pay" && <PayDialog totalMinor={totals.total} customer={customer} employees={employees} onPay={pay} onClose={() => { setDialog(null); focusScan(); }} />}
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
          title={dialog.required ? `«${lines.find((l) => l.key === dialog.key)?.name ?? ""}» ما عندهش سعر` : "تعديل السعر"}
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
          onPick={(c) => { setCustomer(c); setDialog(null); focusScan(); }}
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
                  if (lines.length) await hold();
                  setLines(c.lines as CartLine[]);
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

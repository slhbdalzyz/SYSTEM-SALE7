import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMoney, formatQty, type CatalogCustomer, type CatalogProduct, type PaymentMethod } from "@pos/shared";
import { api } from "../api";
import { db, getMeta, nextInvoiceNumber, setMeta, type HeldCart, type LocalShift } from "../localdb";
import { findByCode, searchProducts } from "../lookup";
import { session, tokenClaims } from "../session";
import { onSync, refreshCounts, startSyncLoop, syncNow, type SyncState } from "../sync";
import type { Screen } from "../App";
import { addLine, cartTotals, lineFor, lineTotal, toSaleInput, type CartLine } from "./cart";
import { AmountDialog, Modal, PayDialog } from "./dialogs";
import { Receipt, type ReceiptData } from "./Receipt";
import { CustomerDialog } from "./CustomerDialog";
import { ReturnDialog, type ReturnDone } from "./ReturnDialog";

type Dialog =
  | { kind: "pay" }
  | { kind: "weight"; product: CatalogProduct }
  | { kind: "qty"; key: string }
  | { kind: "price"; key: string }
  | { kind: "discount" }
  | { kind: "openShift" }
  | { kind: "closeShift"; expected: number }
  | { kind: "held"; carts: HeldCart[] }
  | { kind: "customer" }
  | { kind: "return" }
  | null;

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
  const scanRef = useRef<HTMLInputElement>(null);
  const device = session.device;
  const role = tokenClaims(session.staffToken)?.role;

  const totals = useMemo(() => cartTotals(lines, invoiceDiscount), [lines, invoiceDiscount]);

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
      try {
        const me = await api<{ stores: { id: string; receipt_footer: string | null }[]; storeId: string }>("/me", { token: session.staffToken });
        await setMeta("store", { footer: me.stores.find((s) => s.id === me.storeId)?.receipt_footer });
      } catch {
        /* offline: keep the footer saved last time */
      }
    })();
    return () => void off();
  }, []);

  useEffect(() => {
    if (sync?.lastSync) void db.products.count().then(setCatalogSize);
  }, [sync?.lastSync]);

  useEffect(() => {
    if (receipt) {
      const t = setTimeout(() => window.print(), 50);
      return () => clearTimeout(t);
    }
  }, [receipt]);

  function put(line: CartLine) {
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

  function clearCart() {
    setLines([]);
    setInvoiceDiscount(0);
    setSelected(null);
    setCustomer(null);
  }

  async function pay(payments: { method: PaymentMethod; amountMinor: number }[]) {
    if (!device) return;
    const id = crypto.randomUUID();
    const number = await nextInvoiceNumber(device.prefix);
    const sale = toSaleInput({ id, number, shiftId: shift?.id ?? null, lines, invoiceDiscountMinor: invoiceDiscount, payments, customerId: customer?.id });
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
    setReceipt({ storeName: device.storeName, footer: store?.footer, deviceName: device.name, cashierName, sale, changeMinor: change, customerName: customer?.name });
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
    setReceipt({ storeName: device.storeName, deviceName: device.name, cashierName, ret: r });
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
    setReceipt({ storeName: device.storeName, deviceName: device.name, cashierName, payment: { customerName: c.name, amountMinor, method, balanceMinor: c.balanceMinor, at } });
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog) return;
      if (e.key === "F12" || (e.key === "Enter" && e.ctrlKey)) {
        e.preventDefault();
        if (lines.length) setDialog({ kind: "pay" });
      } else if (e.key === "F2") {
        e.preventDefault();
        focusScan();
      } else if (e.key === "F8") {
        e.preventDefault();
        void hold();
      } else if (e.key === "Delete" && selected) {
        removeLine(selected);
      } else if (e.key === "+" && selected && document.activeElement !== scanRef.current) {
        changeQty(selected, 1000);
      } else if (e.key === "-" && selected && document.activeElement !== scanRef.current) {
        changeQty(selected, -1000);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const selectedLine = lines.find((l) => l.key === selected);
  const canOverride = role === "owner" || role === "manager";

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
        <button onClick={() => void syncNow()}>مزامنة</button>
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
                  {lines.map((l, i) => (
                    <tr key={l.key} className={l.key === selected ? "sel" : ""} onClick={() => setSelected(l.key)}>
                      <td className="num">{i + 1}</td>
                      <td>{l.name}{l.discountMinor > 0 && <div className="muted">خصم {formatMoney(l.discountMinor)}</div>}</td>
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
          </div>
          <div className="keys">
            <button onClick={() => selected && setDialog({ kind: "qty", key: selected })} disabled={!selected}>الكمية</button>
            <button onClick={() => selected && setDialog({ kind: "price", key: selected })} disabled={!selected || !canOverride}>تعديل السعر</button>
            <button onClick={() => setDialog({ kind: "discount" })} disabled={!lines.length}>خصم على الفاتورة</button>
            <button onClick={() => selectedLine && removeLine(selectedLine.key)} disabled={!selected} className="danger">حذف الصنف</button>
            <button onClick={hold} disabled={!lines.length}>تعليق (F8)</button>
            <button onClick={async () => setDialog({ kind: "held", carts: await db.held.toArray() })}>الفواتير المعلقة</button>
            <button onClick={() => setDialog({ kind: "customer" })}>{customer ? `العميل: ${customer.name}` : "العميل / تسديد"}</button>
            <button onClick={() => setDialog({ kind: "return" })} disabled={!shift}>مرتجع</button>
            <button onClick={() => receipt && window.print()} disabled={!receipt}>إعادة طباعة</button>
            <button onClick={clearCart} disabled={!lines.length} className="danger">إلغاء الفاتورة</button>
            <button className="primary pay" disabled={!lines.length || !shift} onClick={() => setDialog({ kind: "pay" })}>
              دفع (F12)
            </button>
          </div>
        </aside>
      </main>

      <Receipt data={receipt} />

      {dialog?.kind === "pay" && <PayDialog totalMinor={totals.total} customer={customer} onPay={pay} onClose={() => { setDialog(null); focusScan(); }} />}
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
          title="تعديل السعر"
          label="السعر الجديد (د.ل)"
          initial={String((lines.find((l) => l.key === dialog.key)?.priceMinor ?? 0) / 1000)}
          onClose={() => { setDialog(null); focusScan(); }}
          onDone={(m) => {
            setLines((ls) => ls.map((l) => (l.key === dialog.key ? { ...l, priceMinor: m } : l)));
            setDialog(null);
            focusScan();
          }}
        />
      )}
      {dialog?.kind === "discount" && (
        <AmountDialog
          title="خصم على الفاتورة"
          label="قيمة الخصم (د.ل)"
          initial={String(invoiceDiscount / 1000)}
          onClose={() => { setDialog(null); focusScan(); }}
          onDone={(m) => {
            setInvoiceDiscount(Math.min(m, totals.subtotal - totals.lineDiscount));
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


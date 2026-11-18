import { useEffect, useState } from "react";
import { formatMoney, formatQty, PRICE_TIER_LABELS, type CatalogCustomer, type CatalogProduct } from "@pos/shared";
import { api } from "../api";
import { db, getMeta, setMeta } from "../localdb";
import { session } from "../session";
import { printQuote, quoteText, type QuoteDoc } from "../printDoc";
import { sendText } from "../whatsapp";
import { lineFor, type CartLine, type Deal } from "./cart";
import { Modal } from "./dialogs";

export interface Quote extends QuoteDoc { id: string; customerId: string | null; status: string; saleNumber: string | null; lines: (QuoteDoc["lines"][number] & { productId: string; unitId: string; taxBp?: number })[] }
export interface Kit { id: string; name: string; active: boolean; items: { productId: string; unitId: string; name: string; unitName: string; qtyMilli: number; priceMinor: number }[] }

const errText = (e: unknown) => (e as Error).message ?? String(e);

/** Rebuilds the bill from a quote's lines, at the quote's prices. Lines whose item is gone are left out. */
async function linesFromQuote(q: Quote): Promise<{ lines: CartLine[]; missing: string[] }> {
  const products = await db.products.bulkGet([...new Set(q.lines.map((l) => l.productId))]);
  const byId = new Map(products.filter((p): p is CatalogProduct => !!p).map((p) => [p.id, p]));
  const lines: CartLine[] = [];
  const missing: string[] = [];
  for (const l of q.lines) {
    const p = byId.get(l.productId);
    const u = p?.units.find((x) => x.id === l.unitId);
    if (!p || !u) { missing.push(l.name); continue; }
    lines.push({ ...lineFor(p, u, l.qtyMilli), priceMinor: l.priceMinor, discountMinor: l.discountMinor ?? 0 });
  }
  return { lines, missing };
}

/**
 * A price quote: the bill on screen saved as a quote (printed or sent on WhatsApp), or a quote opened
 * by its number to sell it now.
 */
export function QuoteDialog({ lines, customer, deal, shopName, shop, onOpen, onClose }: {
  lines: CartLine[]; customer: CatalogCustomer | null; deal: Deal; shopName: string; shop: { phone?: string | null; address?: string | null };
  onOpen: (r: { quote: Quote; lines: CartLine[]; customer: CatalogCustomer | null }) => void; onClose: () => void;
}) {
  const [mode, setMode] = useState<"save" | "open">(lines.length ? "save" : "open");
  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [project, setProject] = useState(deal.project ?? "");
  const [days, setDays] = useState("7");
  const [note, setNote] = useState("");
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Quote | null>(null);
  const total = lines.reduce((a, l) => a + Math.round((l.qtyMilli * l.priceMinor) / 1000) - l.discountMinor, 0);

  async function save() {
    setBusy(true); setError("");
    try {
      const q = await api<Quote>("/quotes", {
        method: "POST", token: session.staffToken,
        body: {
          customerId: customer?.id ?? null, customerName: name.trim() || null, phone: phone.trim() || null, project: project.trim() || null,
          validDays: Math.max(1, Math.min(365, Number(days) || 7)), note: note.trim() || null,
          lines: lines.map((l) => ({ productId: l.productId, unitId: l.unitId, name: l.name, qtyMilli: l.qtyMilli, priceMinor: l.priceMinor, discountMinor: l.discountMinor, taxBp: l.taxBp })),
        },
      });
      setSaved(q);
    } catch (e) { setError(errText(e)); }
    setBusy(false);
  }

  async function open() {
    const n = Number(number);
    if (!n) return setError("اكتب رقم العرض");
    setBusy(true); setError("");
    try {
      const q = await api<Quote>(`/quotes/${n}`, { token: session.staffToken });
      const r = await linesFromQuote(q);
      if (!r.lines.length) throw new Error("أصناف العرض مش موجودة على هذا الجهاز. استنى المزامنة");
      const c = q.customerId ? (await db.customers.get(q.customerId)) ?? null : null;
      if (r.missing.length) alert(`ما لقيناش: ${r.missing.join("، ")}`);
      onOpen({ quote: q, lines: r.lines, customer: c });
    } catch (e) { setError(errText(e)); }
    setBusy(false);
  }

  if (saved) {
    const shopInfo = { name: shopName, ...shop };
    return (
      <Modal title={`✓ عرض السعر رقم ${saved.number}`} onClose={onClose}>
        <p>الإجمالي <b className="num">{formatMoney(saved.totalMinor)}</b>{saved.validUntil ? ` · صالح حتى ${saved.validUntil.slice(0, 10).split("-").reverse().join("/")}` : ""}.</p>
        <p className="muted">لما يرجع الزبون يشتري: «📄 عرض سعر» ← «افتح عرض» واكتب الرقم {saved.number}.</p>
        <div className="row">
          <button onClick={() => printQuote(saved, shopInfo)}>🖨️ اطبع</button>
          <button onClick={() => sendText(saved.phone, quoteText(saved, shopName))}>📲 واتساب</button>
          <span className="spacer" />
          <button className="primary" onClick={onClose}>تم</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="📄 عرض سعر" onClose={onClose}>
      <div className="chips">
        <button className={mode === "save" ? "active" : ""} disabled={!lines.length} onClick={() => setMode("save")}>احفظ الفاتورة كعرض</button>
        <button className={mode === "open" ? "active" : ""} onClick={() => setMode("open")}>افتح عرض للبيع</button>
      </div>
      {mode === "save" ? (
        <>
          <p>{lines.length} أصناف · <b className="num">{formatMoney(total)}</b></p>
          <label>اسم الزبون<input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="شركة، مقاول، أو شخص" /></label>
          <label>رقم الهاتف<input value={phone} maxLength={30} inputMode="tel" onChange={(e) => setPhone(e.target.value)} /></label>
          <label>المشروع / الموقع<input value={project} maxLength={80} onChange={(e) => setProject(e.target.value)} placeholder="مثلاً: فيلا قرجي" /></label>
          <label>صالح كم يوم<input value={days} inputMode="numeric" onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} /></label>
          <label>ملاحظة<input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: التوصيل مجاني داخل المدينة" /></label>
        </>
      ) : (
        <label>رقم العرض
          <input autoFocus value={number} inputMode="numeric" onChange={(e) => setNumber(e.target.value.replace(/\D/g, ""))} onKeyDown={(e) => e.key === "Enter" && void open()} />
        </label>
      )}
      {error && <div className="error">{error}</div>}
      <div className="row">
        <span className="spacer" />
        <button onClick={onClose}>إلغاء</button>
        {mode === "save"
          ? <button className="primary" disabled={busy || !lines.length} onClick={() => void save()}>احفظ العرض</button>
          : <button className="primary" disabled={busy} onClick={() => void open()}>افتح</button>}
      </div>
    </Modal>
  );
}

/** The shop's ready-made lists, kept on the device so they work without internet. */
export async function loadKits(): Promise<Kit[]> {
  try {
    const k = await api<Kit[]>("/kits", { token: session.staffToken });
    await setMeta("kits", k);
    return k;
  } catch {
    return (await getMeta<Kit[]>("kits")) ?? [];
  }
}

/** A ready-made list (a school list, a bathroom set, a gift box) put on the bill in one go. */
export function KitDialog({ onPick, onClose }: { onPick: (lines: CartLine[], name: string) => void; onClose: () => void }) {
  const [kits, setKits] = useState<Kit[] | null>(null);
  const [times, setTimes] = useState("1");
  useEffect(() => void loadKits().then(setKits), []);

  async function pick(k: Kit) {
    const n = Math.max(1, Number(times) || 1);
    const ps = await db.products.bulkGet([...new Set(k.items.map((i) => i.productId))]);
    const byId = new Map(ps.filter((p): p is CatalogProduct => !!p).map((p) => [p.id, p]));
    const lines: CartLine[] = [];
    for (const i of k.items) {
      const p = byId.get(i.productId);
      const u = p?.units.find((x) => x.id === i.unitId);
      if (p && u) lines.push(lineFor(p, u, i.qtyMilli * n));
    }
    onPick(lines, k.name);
  }

  return (
    <Modal title="🎒 قائمة جاهزة" onClose={onClose} wide>
      <label>كم نسخة<input value={times} inputMode="numeric" style={{ maxWidth: 100 }} onChange={(e) => setTimes(e.target.value.replace(/\D/g, ""))} /></label>
      {!kits ? <p className="muted">جاري التحميل…</p> : !kits.length ? (
        <p className="muted">ما فيش قوائم جاهزة. يديروها من الإدارة ← «القوائم الجاهزة» (مثلاً قائمة الصف الأول، طقم حمام، بوكس هدية).</p>
      ) : (
        <div className="kit-grid">
          {kits.map((k) => (
            <button key={k.id} className="kit-card" onClick={() => void pick(k)}>
              <b>{k.name}</b>
              <span className="muted">{k.items.length} أصناف · <span className="num">{formatMoney(k.items.reduce((a, i) => a + Math.round((i.qtyMilli * i.priceMinor) / 1000), 0))}</span></span>
              <small className="muted">{k.items.slice(0, 4).map((i) => `${i.name} × ${formatQty(i.qtyMilli, i.qtyMilli % 1000 !== 0)}`).join("، ")}{k.items.length > 4 ? "…" : ""}</small>
            </button>
          ))}
        </div>
      )}
      <div className="row"><span className="spacer" /><button onClick={onClose}>إغلاق</button></div>
    </Modal>
  );
}

/** What goes with the bill: the building site it is for, and an address to take it to. */
export function DealDialog({ deal, customer, onDone, onClose }: { deal: Deal; customer: CatalogCustomer | null; onDone: (d: Deal) => void; onClose: () => void }) {
  const [project, setProject] = useState(deal.project ?? "");
  const [deliver, setDeliver] = useState(!!deal.delivery);
  const [address, setAddress] = useState(deal.delivery?.address ?? "");
  const [phone, setPhone] = useState(deal.delivery?.phone ?? customer?.phone ?? "");
  const [note, setNote] = useState(deal.delivery?.note ?? "");
  const [error, setError] = useState("");
  function done() {
    if (deliver && address.trim().length < 2) return setError("اكتب عنوان التوصيل");
    onDone({ ...deal, project: project.trim() || null, delivery: deliver ? { address: address.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) } : null });
  }
  return (
    <Modal title="🏗️ مشروع وتوصيل" onClose={onClose}>
      <label>المشروع / الموقع
        <input autoFocus value={project} maxLength={80} onChange={(e) => setProject(e.target.value)} placeholder="مثلاً: عمارة السراج، الدور الثاني" />
      </label>
      {customer ? <p className="muted">ينحسب في كشف {customer.name} تحت هذا المشروع.</p> : <p className="muted">اختار العميل (F3) باش يطلع المشروع في كشف حسابه.</p>}
      <label className="check"><input type="checkbox" checked={deliver} onChange={(e) => setDeliver(e.target.checked)} /> 🚚 توصيل للزبون</label>
      {deliver && (
        <>
          <label>العنوان<input value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} placeholder="المنطقة، الشارع، علامة قريبة" /></label>
          <label>هاتف الاستلام<input value={phone} maxLength={30} inputMode="tel" onChange={(e) => setPhone(e.target.value)} /></label>
          <label>ملاحظة للسائق<input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: يتصل قبل ما يوصل" /></label>
        </>
      )}
      {error && <div className="error">{error}</div>}
      <div className="row">
        {(deal.project || deal.delivery) && <button className="danger" onClick={() => onDone({ ...deal, project: null, delivery: null })}>شيلهم</button>}
        <span className="spacer" />
        <button onClick={onClose}>إلغاء</button>
        <button className="primary" onClick={done}>تم</button>
      </div>
    </Modal>
  );
}

/** The deal on the bill, shown under the total. */
export function DealBox({ deal, onEdit, onClearQuote }: { deal: Deal; onEdit: () => void; onClearQuote: () => void }) {
  if (!deal.quoteNumber && !deal.project && !deal.delivery) return null;
  return (
    <div className="deal-box">
      {deal.quoteNumber && <div>📄 من عرض السعر رقم {deal.quoteNumber} <button className="link" onClick={onClearQuote}>✕</button></div>}
      {deal.project && <div onClick={onEdit}>🏗️ {deal.project}</div>}
      {deal.delivery && <div onClick={onEdit}>🚚 {deal.delivery.address}{deal.delivery.phone ? ` · ${deal.delivery.phone}` : ""}</div>}
    </div>
  );
}

export const tierLabel = (c: CatalogCustomer | null) => (c?.priceTier && c.priceTier !== "retail" ? PRICE_TIER_LABELS[c.priceTier] : null);

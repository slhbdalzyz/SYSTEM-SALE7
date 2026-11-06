import { useEffect, useState } from "react";
import { formatMoney, readShopSettings, toMinor, type CatalogCustomer, type LoyaltySettings, type ShopSettings } from "@pos/shared";
import { sendDebtReminder } from "../whatsapp";
import { Modal } from "../pos/dialogs";
import type { Call } from "./Admin";

interface Entry { at: string; type: "sale" | "return" | "payment"; ref: string; amount_minor: number; balance_minor: number }
const TYPE = { sale: "فاتورة آجل", return: "مرتجع", payment: "تسديد" } as const;

interface PointsEntry { id: string; points: number; kind: "earn" | "redeem" | "return" | "adjust"; note: string | null; created_at: string; sale_number: string | null; user_name: string | null }
const POINTS_KIND = { earn: "كسب", redeem: "صرف", return: "مرتجع", adjust: "تعديل يدوي" } as const;

export function Customers({ call, isOwner = false }: { call: Call; isOwner?: boolean }) {
  // Points show only while the shop has them switched on (in the settings).
  const [loyalty, setLoyalty] = useState(false);
  useEffect(() => void call<LoyaltySettings>("/loyalty/settings").then((r) => setLoyalty(r.enabled)).catch(() => undefined), [call]);
  const [points, setPoints] = useState<{ customer: { id: string; name: string }; points: number; entries: PointsEntry[] } | null>(null);
  const [adjust, setAdjust] = useState({ points: "", note: "" });
  const [list, setList] = useState<CatalogCustomer[]>([]);
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<{ id?: string; name: string; phone: string; limit: string; noLimit: boolean } | null>(null);
  const [statement, setStatement] = useState<{ customer: CatalogCustomer; entries: Entry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shop, setShop] = useState<{ name: string; settings: ShopSettings } | null>(null);
  const [remind, setRemind] = useState(false);
  const [sent, setSent] = useState<Set<string>>(new Set());
  useEffect(() => void call<{ name: string; settings: unknown }>("/settings").then((r) => setShop({ name: r.name, settings: readShopSettings(r.settings) })).catch(() => undefined), [call]);
  const owing = list.filter((c) => c.balanceMinor > 0).sort((a, b) => b.balanceMinor - a.balanceMinor);
  const nudge = (c: CatalogCustomer) => {
    sendDebtReminder({ shopName: shop?.name ?? "", settings: shop?.settings, name: c.name, balanceMinor: c.balanceMinor, phone: c.phone });
    setSent((s) => new Set(s).add(c.id));
  };

  const load = () => call<CatalogCustomer[]>(`/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`).then(setList);
  useEffect(() => void load(), [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalDebt = list.reduce((a, c) => a + Math.max(c.balanceMinor, 0), 0);

  async function save() {
    if (!edit) return;
    setError(null);
    const body = { name: edit.name, phone: edit.phone || null, creditLimitMinor: edit.noLimit ? null : toMinor(Number(edit.limit) || 0) };
    try {
      await call(edit.id ? `/customers/${edit.id}` : "/customers", { method: edit.id ? "PATCH" : "POST", body });
      setEdit(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <input placeholder="بحث بالاسم أو الهاتف" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <span className="muted">إجمالي الديون: <b className="num">{formatMoney(totalDebt)}</b></span>
        <span className="spacer" />
        <button onClick={() => setRemind(true)} disabled={!owing.length}>📲 تذكير المدينين ({owing.length})</button>
        <button className="primary" onClick={() => setEdit({ name: "", phone: "", limit: "0", noLimit: false })}>+ عميل</button>
      </div>
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>العميل</th><th>الهاتف</th><th>الرصيد</th><th>حد الآجل</th>{loyalty && <th>النقاط</th>}<th /></tr></thead>
          <tbody>
            {list.map((c) => {
              const over = c.creditLimitMinor !== null && c.balanceMinor > c.creditLimitMinor;
              return (
                <tr key={c.id} style={{ opacity: c.active ? 1 : 0.5 }}>
                  <td>{c.name}</td>
                  <td className="num">{c.phone ?? "—"}</td>
                  <td><span className={over ? "badge bad" : ""}><span className="num">{formatMoney(c.balanceMinor)}</span></span></td>
                  <td className="num">{c.creditLimitMinor === null ? "بدون حد" : c.creditLimitMinor === 0 ? "بدون آجل" : formatMoney(c.creditLimitMinor)}</td>
                  {loyalty && <td className="num">⭐ {c.points ?? 0}</td>}
                  <td className="row">
                    <button onClick={async () => setStatement(await call(`/customers/${c.id}/statement`))}>كشف حساب</button>
                    {c.balanceMinor > 0 && <button onClick={() => nudge(c)} title={c.phone ? "" : "ما عندهش رقم: تختار المحادثة من الواتساب"}>{sent.has(c.id) ? "✓ تذكير" : "📲 تذكير"}</button>}
                    {loyalty && <button onClick={async () => { setError(null); setAdjust({ points: "", note: "" }); setPoints(await call(`/customers/${c.id}/points`)); }}>⭐ النقاط</button>}
                    <button onClick={() => setEdit({ id: c.id, name: c.name, phone: c.phone ?? "", limit: String((c.creditLimitMinor ?? 0) / 1000), noLimit: c.creditLimitMinor === null })}>تعديل</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {edit && (
        <Modal title={edit.id ? "تعديل عميل" : "عميل جديد"} onClose={() => setEdit(null)}>
          <label>الاسم<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></label>
          <label>الهاتف<input className="num" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></label>
          <label className="row" style={{ color: "var(--ink)" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={edit.noLimit} onChange={(e) => setEdit({ ...edit, noLimit: e.target.checked })} />
            آجل بدون حد
          </label>
          {!edit.noLimit && <label>حد الآجل (د.ل) — صفر يعني بدون آجل<input className="num" value={edit.limit} onChange={(e) => setEdit({ ...edit, limit: e.target.value })} /></label>}
          {error && <div className="error">{error}</div>}
          <div className="row"><span className="spacer" /><button onClick={() => setEdit(null)}>إلغاء</button><button className="primary" disabled={edit.name.length < 2} onClick={save}>حفظ</button></div>
        </Modal>
      )}

      {points && (
        <Modal title={`نقاط: ${points.customer.name}`} onClose={() => setPoints(null)}>
          <div className="row"><b>الرصيد</b><span className="spacer" /><b className="num">⭐ {points.points}</b></div>
          <table>
            <thead><tr><th>التاريخ</th><th>البيان</th><th>النقاط</th></tr></thead>
            <tbody>
              {points.entries.map((e) => (
                <tr key={e.id}>
                  <td className="num">{new Date(e.created_at).toLocaleDateString("en-GB")}</td>
                  <td>{POINTS_KIND[e.kind]} <span className="num muted">{e.sale_number ?? ""}</span>{e.note && <span className="muted"> · {e.note}</span>}</td>
                  <td className="num" style={{ color: e.points > 0 ? "var(--ok)" : "var(--danger)" }}>{e.points > 0 ? `+${e.points}` : e.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {points.entries.length === 0 && <span className="muted">ما فيش نقاط لين توا</span>}
          <div className="form-grid">
            <label>إضافة أو خصم (مثلاً 50 أو ‎-50)<input className="num" inputMode="numeric" value={adjust.points} onChange={(e) => setAdjust({ ...adjust, points: e.target.value })} /></label>
            <label>السبب<input value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} /></label>
          </div>
          {error && <div className="error">{error}</div>}
          <div className="row">
            <span className="spacer" />
            <button className="primary" disabled={!Number(adjust.points) || adjust.note.trim().length < 2} onClick={async () => {
              setError(null);
              try {
                await call(`/customers/${points.customer.id}/points`, { body: { points: Math.round(Number(adjust.points)), note: adjust.note.trim() } });
                setPoints(await call(`/customers/${points.customer.id}/points`));
                setAdjust({ points: "", note: "" });
                await load();
              } catch (e) {
                setError((e as Error).message);
              }
            }}>حفظ التعديل</button>
          </div>
        </Modal>
      )}

      {statement && (
        <Modal title={`كشف حساب: ${statement.customer.name}`} onClose={() => setStatement(null)}>
          <table>
            <thead><tr><th>التاريخ</th><th>البيان</th><th>المبلغ</th><th>الرصيد</th></tr></thead>
            <tbody>
              {statement.entries.map((e, i) => (
                <tr key={i}>
                  <td className="num">{new Date(e.at).toLocaleDateString("en-GB")}</td>
                  <td>{TYPE[e.type]} <span className="num muted">{e.type === "payment" ? (e.ref === "cash" ? "كاش" : "بطاقة") : e.ref}</span></td>
                  <td className="num">{formatMoney(e.amount_minor)}</td>
                  <td className="num">{formatMoney(e.balance_minor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {statement.entries.length === 0 && <span className="muted">ما فيش حركات</span>}
          <div className="row"><b>الرصيد الحالي</b><span className="spacer" /><b className="num">{formatMoney(statement.customer.balanceMinor)}</b></div>
        </Modal>
      )}
      {remind && (
        <Modal title="📲 تذكير المدينين على الواتساب" onClose={() => setRemind(false)}>
          <div className="muted">كل زر يفتح الواتساب على محادثة العميل والرسالة جاهزة. الرسالة تتعدل من ⚙️ الإعدادات.</div>
          <div className="remind-list">
            {owing.map((c) => (
              <div key={c.id} className="row">
                <span>{c.name}</span>
                <span className="muted num">{c.phone ?? "بدون رقم"}</span>
                <span className="spacer" />
                <b className="num">{formatMoney(c.balanceMinor)}</b>
                <button className={sent.has(c.id) ? "" : "primary"} onClick={() => nudge(c)}>{sent.has(c.id) ? "✓ تبعت" : "إرسال"}</button>
              </div>
            ))}
          </div>
          <div className="row"><span className="muted">{sent.size} من {owing.length}</span><span className="spacer" /><button onClick={() => setRemind(false)}>إغلاق</button></div>
        </Modal>
      )}
    </div>
  );
}

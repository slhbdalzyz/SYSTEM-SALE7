// Yearly licences for the desktop's local edition: the shop sends its computer's ID, the platform
// issues a signed key here and sends it back (copy or WhatsApp). A renewal starts the day after.
import { useEffect, useState } from "react";
import { formatMoney } from "@pos/shared";
import { parseMoney } from "../billing";

type Call = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

interface L { id: string; root_id: string; shop_name: string; phone: string | null; machine_id: string; valid_from: string; valid_until: string; devices: number; amount_minor: number; note: string | null; key: string; revoked: boolean; created_at: string; created_by_name: string | null; latest: boolean }

const blank = { shopName: "", phone: "", machineId: "", years: "1", devices: "1", amount: "", note: "" };

export function LicensesTab({ call }: { call: Call }) {
  const [rows, setRows] = useState<L[]>([]);
  const [f, setF] = useState(blank);
  const [renewOf, setRenewOf] = useState<L | null>(null);
  const [issued, setIssued] = useState<{ key: string; until: string; phone: string; shop: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const load = () => call<L[]>("/platform/licenses").then(setRows).catch((e) => setError((e as Error).message));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function issue() {
    setError(null);
    try {
      const r = await call<{ key: string; validUntil: string }>("/platform/licenses", {
        body: { shopName: f.shopName, phone: f.phone || undefined, machineId: f.machineId, years: Number(f.years) || 1, devices: Number(f.devices) || 1, amountMinor: f.amount ? parseMoney(f.amount) : 0, note: f.note || undefined, renewOf: renewOf?.id },
      });
      setIssued({ key: r.key, until: r.validUntil, phone: f.phone, shop: f.shopName });
      setF(blank);
      setRenewOf(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const renew = (l: L) => {
    setRenewOf(l);
    setIssued(null);
    setF({ ...blank, shopName: l.shop_name, phone: l.phone ?? "", machineId: l.machine_id, devices: String(l.devices) });
    window.scrollTo?.(0, 0);
  };
  const wa = (phone: string, text: string) => `https://wa.me/${phone.replace(/\D/g, "").replace(/^0/, "218")}?text=${encodeURIComponent(text)}`;
  const shown = rows.filter((r) => !q || `${r.shop_name} ${r.phone ?? ""} ${r.machine_id}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="stack">
      <div className="card stack">
        <h3 style={{ margin: 0 }}>{renewOf ? `تجديد ترخيص ${renewOf.shop_name}` : "ترخيص سنوي جديد (نسخة سطح المكتب)"}</h3>
        <div className="row" style={{ alignItems: "end" }}>
          <label>اسم المحل<input value={f.shopName} onChange={(e) => setF({ ...f, shopName: e.target.value })} /></label>
          <label>الهاتف<input className="num" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="09xxxxxxxx" style={{ width: 130 }} /></label>
          <label>رقم الجهاز<input dir="ltr" value={f.machineId} onChange={(e) => setF({ ...f, machineId: e.target.value.toUpperCase() })} placeholder="1A2B-3C4D-5E6F-7A8B" style={{ width: 200, fontFamily: "monospace" }} disabled={!!renewOf} /></label>
          <label>سنوات<input className="num" value={f.years} onChange={(e) => setF({ ...f, years: e.target.value })} style={{ width: 60 }} /></label>
          <label>أجهزة<input className="num" value={f.devices} onChange={(e) => setF({ ...f, devices: e.target.value })} style={{ width: 60 }} /></label>
          <label>المبلغ (د.ل)<input className="num" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={{ width: 100 }} /></label>
          <label>ملاحظة<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <button className="primary" disabled={f.shopName.trim().length < 2 || f.machineId.replace(/[^0-9A-F]/g, "").length !== 16} onClick={issue}>{renewOf ? "إصدار التجديد" : "إصدار المفتاح"}</button>
          {renewOf && <button onClick={() => { setRenewOf(null); setF(blank); }}>إلغاء</button>}
        </div>
        <div className="muted">صاحب المحل يلقى «رقم الجهاز» في صفحة «⭐ الترخيص» داخل البرنامج. المفتاح يشتغل على ذاك الجهاز بس، ومن غير نت. التجديد يبدأ من اليوم اللي بعد نهاية الترخيص القديم، ويوصل وحده لو جهاز المحل متصل بالنت.</div>
      </div>
      {error && <div className="error">{error}</div>}
      {issued && (
        <div className="card stack" style={{ borderColor: "var(--brand)" }}>
          <b>✓ مفتاح {issued.shop}، صالح لين {issued.until}</b>
          <textarea readOnly dir="ltr" rows={4} value={issued.key} style={{ fontFamily: "monospace" }} onFocus={(e) => e.target.select()} />
          <div className="row">
            <button onClick={() => void navigator.clipboard?.writeText(issued.key)}>نسخ المفتاح</button>
            {issued.phone && <a className="button" target="_blank" rel="noopener" href={wa(issued.phone, `مفتاح تفعيل نظام نقاط البيع (صالح لين ${issued.until}):\n\n${issued.key}\n\nالصقه في صفحة «⭐ الترخيص» واضغط «تفعيل».`)}>ابعته على الواتساب</a>}
          </div>
        </div>
      )}
      <div className="card" style={{ overflowX: "auto" }}>
        <div className="row"><input placeholder="بحث بالاسم أو الهاتف أو رقم الجهاز" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} /></div>
        <table>
          <thead><tr><th>المحل</th><th>رقم الجهاز</th><th>من</th><th>لين</th><th>أجهزة</th><th>المبلغ</th><th>أصدره</th><th /></tr></thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id} style={l.revoked ? { opacity: 0.5 } : undefined}>
                <td>{l.shop_name}{l.phone && <div className="muted small num">{l.phone}</div>}</td>
                <td className="num" dir="ltr">{l.machine_id}</td>
                <td className="num">{l.valid_from}</td>
                <td className="num">{l.valid_until}{l.revoked && <span className="badge bad" style={{ marginInlineStart: 6 }}>ملغي</span>}</td>
                <td className="num">{l.devices}</td>
                <td className="num">{l.amount_minor ? formatMoney(l.amount_minor) : "—"}</td>
                <td>{l.created_by_name ?? "—"}</td>
                <td className="row" style={{ flexWrap: "nowrap" }}>
                  <button onClick={() => { setIssued({ key: l.key, until: l.valid_until, phone: l.phone ?? "", shop: l.shop_name }); window.scrollTo?.(0, 0); }}>المفتاح</button>
                  {l.latest && !l.revoked && <button onClick={() => renew(l)}>تجديد</button>}
                  {!l.revoked && <button className="danger" onClick={() => confirm("إلغاء الترخيص يوقف تجديده التلقائي. المفتاح اللي على الجهاز يكمل لين تاريخه. متأكد؟") && void call(`/platform/licenses/${l.id}/revoke`, { method: "POST" }).then(load)}>إلغاء</button>}
                </td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={8} className="muted">ما فيش تراخيص بعد</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

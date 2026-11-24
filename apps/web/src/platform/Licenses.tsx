// Yearly licences for the desktop's local edition: the shop sends its computer's ID, the platform
// issues a signed key here and sends it back (copy or WhatsApp). A renewal starts the day after.
// Keys are sold as packages (small, medium, large: how many cashier tills), set at the top.
import { useEffect, useState } from "react";
import { formatMoney, quoteLicense, upgradePrice, type LicensePlans } from "@pos/shared";
import { parseMoney } from "../billing";

type Call = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

interface L { id: string; root_id: string; shop_name: string; phone: string | null; machine_id: string; valid_from: string; valid_until: string; devices: number; amount_minor: number; note: string | null; key: string; revoked: boolean; created_at: string; created_by_name: string | null; latest: boolean; plan: string | null; extra_devices: number; annual_minor: number | null; upgrade_of: string | null }

const blank = { shopName: "", phone: "", machineId: "", years: "1", devices: "1", plan: "medium", extra: "0", amount: "", note: "" };
const money = (m: number) => formatMoney(m).replace(".000", "");
const today = () => new Date().toISOString().slice(0, 10);

export function LicensesTab({ call }: { call: Call }) {
  const [rows, setRows] = useState<L[]>([]);
  const [plans, setPlans] = useState<LicensePlans | null>(null);
  const [f, setF] = useState(blank);
  const [renewOf, setRenewOf] = useState<L | null>(null);
  const [upgradeOf, setUpgradeOf] = useState<L | null>(null);
  const [issued, setIssued] = useState<{ key: string; until: string; phone: string; shop: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const load = () => call<L[]>("/platform/licenses").then(setRows).catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
    void call<LicensePlans>("/platform/license-plans").then(setPlans).catch((e) => setError((e as Error).message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const custom = f.plan === "";
  const years = Math.max(1, Number(f.years) || 1);
  const extra = Math.max(0, Number(f.extra) || 0);
  const quote = plans && !custom ? quoteLicense(plans, { planId: f.plan, extra, years }) : null;
  const up = upgradeOf && quote ? upgradePrice({ oldAnnualMinor: upgradeOf.annual_minor ?? upgradeOf.amount_minor, newAnnualMinor: quoteLicense(plans!, { planId: f.plan, extra, years: 1 }).annualMinor, today: today(), until: upgradeOf.valid_until }) : null;
  const suggested = up ? up.totalMinor : quote?.totalMinor ?? null;

  async function issue() {
    setError(null);
    try {
      const amountMinor = f.amount ? parseMoney(f.amount) : custom ? 0 : undefined;
      const r = upgradeOf
        ? await call<{ key: string; validUntil: string }>(`/platform/licenses/${upgradeOf.id}/upgrade`, { body: { plan: f.plan, extraDevices: extra, amountMinor, note: f.note || undefined } })
        : await call<{ key: string; validUntil: string }>("/platform/licenses", {
            body: {
              shopName: f.shopName, phone: f.phone || undefined, machineId: f.machineId, years, note: f.note || undefined, renewOf: renewOf?.id, amountMinor,
              ...(custom ? { devices: Number(f.devices) || 1 } : { plan: f.plan, extraDevices: extra }),
            },
          });
      setIssued({ key: r.key, until: r.validUntil, phone: f.phone, shop: f.shopName });
      setF(blank);
      setRenewOf(null);
      setUpgradeOf(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const fill = (l: L) => ({ ...blank, shopName: l.shop_name, phone: l.phone ?? "", machineId: l.machine_id, devices: String(l.devices), plan: l.plan ?? "", extra: String(l.extra_devices ?? 0) });
  const renew = (l: L) => {
    setRenewOf(l);
    setUpgradeOf(null);
    setIssued(null);
    setF(fill(l));
    window.scrollTo?.(0, 0);
  };
  const upgrade = (l: L) => {
    setUpgradeOf(l);
    setRenewOf(null);
    setIssued(null);
    // The next package up, or more tills on the biggest.
    const bigger = plans?.plans.filter((p) => p.devices > l.devices).sort((a, b) => a.devices - b.devices)[0];
    setF({ ...fill(l), plan: bigger?.id ?? l.plan ?? plans?.plans.at(-1)?.id ?? "", extra: bigger ? "0" : String((l.extra_devices ?? 0) + 1) });
    window.scrollTo?.(0, 0);
  };
  const cancel = () => { setRenewOf(null); setUpgradeOf(null); setF(blank); };
  const wa = (phone: string, text: string) => `https://wa.me/${phone.replace(/\D/g, "").replace(/^0/, "218")}?text=${encodeURIComponent(text)}`;
  const shown = rows.filter((r) => !q || `${r.shop_name} ${r.phone ?? ""} ${r.machine_id}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="stack">
      {plans && <PlansCard plans={plans} call={call} onSaved={setPlans} />}
      <div className="card stack">
        <h3 style={{ margin: 0 }}>{upgradeOf ? `ترقية باقة ${upgradeOf.shop_name}` : renewOf ? `تجديد ترخيص ${renewOf.shop_name}` : "ترخيص سنوي جديد (نسخة سطح المكتب)"}</h3>
        <div className="row" style={{ alignItems: "end" }}>
          <label>اسم المحل<input value={f.shopName} onChange={(e) => setF({ ...f, shopName: e.target.value })} /></label>
          <label>الهاتف<input className="num" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="09xxxxxxxx" style={{ width: 130 }} /></label>
          <label>رقم الجهاز<input dir="ltr" value={f.machineId} onChange={(e) => setF({ ...f, machineId: e.target.value.toUpperCase() })} placeholder="1A2B-3C4D-5E6F-7A8B" style={{ width: 200, fontFamily: "monospace" }} disabled={!!renewOf} /></label>
          <label>الباقة
            <select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value, amount: "" })}>
              {plans?.plans.map((p) => <option key={p.id} value={p.id}>{p.name}: {p.devices} كاشير · {money(p.priceMinor)}</option>)}
              {!upgradeOf && <option value="">مخصص (أكتب العدد والمبلغ)</option>}
            </select>
          </label>
          {custom ? (
            <label>أجهزة<input className="num" value={f.devices} onChange={(e) => setF({ ...f, devices: e.target.value })} style={{ width: 60 }} /></label>
          ) : (
            <label title={plans ? `كل جهاز زيادة ${money(plans.extraDeviceMinor)} في السنة` : ""}>أجهزة زيادة<input className="num" value={f.extra} onChange={(e) => setF({ ...f, extra: e.target.value, amount: "" })} style={{ width: 60 }} /></label>
          )}
          {!upgradeOf && <label>سنوات<input className="num" value={f.years} onChange={(e) => setF({ ...f, years: e.target.value, amount: "" })} style={{ width: 60 }} /></label>}
          <label>المبلغ (د.ل)<input className="num" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder={suggested !== null ? String(suggested / 1000) : ""} style={{ width: 100 }} /></label>
          <label>ملاحظة<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <button className="primary" disabled={f.shopName.trim().length < 2 || f.machineId.replace(/[^0-9A-F]/g, "").length !== 16} onClick={issue}>{upgradeOf ? "إصدار الترقية" : renewOf ? "إصدار التجديد" : "إصدار المفتاح"}</button>
          {(renewOf || upgradeOf) && <button onClick={cancel}>إلغاء</button>}
        </div>
        {quote && (
          <div className="notice">
            {upgradeOf && up ? (
              <>من {upgradeOf.devices} لـ <b>{quote.devices}</b> كاشير، لين <b className="num">{upgradeOf.valid_until}</b> (نفس النهاية). الفرق في السنة {money(Math.max(0, quoteLicense(plans!, { planId: f.plan, extra, years: 1 }).annualMinor - (upgradeOf.annual_minor ?? upgradeOf.amount_minor)))} × {up.days} يوم باقي = <b>{money(up.totalMinor)}</b></>
            ) : (
              <>{quote.plan?.name}{extra > 0 && ` + ${extra} جهاز زيادة`}: <b>{quote.devices}</b> كاشير · {money(quote.annualMinor)} في السنة × {years}{quote.discountPct > 0 && ` − خصم ${quote.discountPct}%`} = <b>{money(quote.totalMinor)}</b></>
            )}
            {f.amount && <span className="muted"> (كتبت مبلغ بإيدك: {money(parseMoney(f.amount) ?? 0)})</span>}
          </div>
        )}
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
          <thead><tr><th>المحل</th><th>رقم الجهاز</th><th>من</th><th>لين</th><th>الباقة</th><th>المبلغ</th><th>أصدره</th><th /></tr></thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id} style={l.revoked ? { opacity: 0.5 } : undefined}>
                <td>{l.shop_name}{l.phone && <div className="muted small num">{l.phone}</div>}</td>
                <td className="num" dir="ltr">{l.machine_id}</td>
                <td className="num">{l.valid_from}</td>
                <td className="num">{l.valid_until}{l.revoked && <span className="badge bad" style={{ marginInlineStart: 6 }}>ملغي</span>}</td>
                <td>{plans?.plans.find((p) => p.id === l.plan)?.name ?? (l.plan ? l.plan : "مخصص")} · <span className="num">{l.devices}</span> كاشير{l.upgrade_of && <span className="badge ok" style={{ marginInlineStart: 6 }}>ترقية</span>}</td>
                <td className="num">{l.amount_minor ? formatMoney(l.amount_minor) : "—"}</td>
                <td>{l.created_by_name ?? "—"}</td>
                <td className="row" style={{ flexWrap: "nowrap" }}>
                  <button onClick={() => { setIssued({ key: l.key, until: l.valid_until, phone: l.phone ?? "", shop: l.shop_name }); window.scrollTo?.(0, 0); }}>المفتاح</button>
                  {l.latest && !l.revoked && <button onClick={() => renew(l)}>تجديد</button>}
                  {l.latest && !l.revoked && l.valid_until >= today() && <button onClick={() => upgrade(l)}>ترقية</button>}
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

/** The packages on sale: tills and yearly price, the price of one more till, multi-year discounts, the seller's WhatsApp. */
function PlansCard({ plans, call, onSaved }: { plans: LicensePlans; call: Call; onSaved: (p: LicensePlans) => void }) {
  const [p, setP] = useState(plans);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setPlan = (i: number, patch: Partial<LicensePlans["plans"][number]>) => setP({ ...p, plans: p.plans.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  async function save() {
    setError(null);
    setMsg(null);
    try {
      onSaved(await call<LicensePlans>("/platform/license-plans", { method: "PUT", body: p }));
      setMsg("تم الحفظ ✓");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const dinars = (m: number) => String(m / 1000);
  return (
    <div className="card stack">
      <div className="row">
        <h3 style={{ margin: 0 }}>📦 باقات التراخيص</h3>
        <span className="muted">{plans.plans.map((x) => `${x.name} ${x.devices} كاشير ${money(x.priceMinor)}`).join(" · ")}</span>
        <span className="spacer" />
        <button onClick={() => setOpen(!open)}>{open ? "إخفاء" : "تعديل"}</button>
      </div>
      {open && (
        <>
          <table>
            <thead><tr><th>الرمز</th><th>الاسم</th><th>عدد الكاشير</th><th>السعر في السنة (د.ل)</th><th /></tr></thead>
            <tbody>
              {p.plans.map((x, i) => (
                <tr key={i}>
                  <td><input dir="ltr" value={x.id} onChange={(e) => setPlan(i, { id: e.target.value.toLowerCase() })} style={{ width: 90 }} /></td>
                  <td><input value={x.name} onChange={(e) => setPlan(i, { name: e.target.value })} style={{ width: 110 }} /></td>
                  <td><input className="num" value={x.devices} onChange={(e) => setPlan(i, { devices: Number(e.target.value) || 0 })} style={{ width: 70 }} /></td>
                  <td><input className="num" value={dinars(x.priceMinor)} onChange={(e) => setPlan(i, { priceMinor: parseMoney(e.target.value) ?? 0 })} style={{ width: 110 }} /></td>
                  <td><button className="ghost" onClick={() => setP({ ...p, plans: p.plans.filter((_, j) => j !== i) })} disabled={p.plans.length < 2}>حذف</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ alignItems: "end" }}>
            <button onClick={() => setP({ ...p, plans: [...p.plans, { id: `plan${p.plans.length + 1}`, name: "", devices: 1, priceMinor: 0 }] })}>+ باقة</button>
            <label>جهاز زيادة فوق الباقة، في السنة (د.ل)<input className="num" value={dinars(p.extraDeviceMinor)} onChange={(e) => setP({ ...p, extraDeviceMinor: parseMoney(e.target.value) ?? 0 })} style={{ width: 110 }} /></label>
            <label>خصم سنتين %<input className="num" value={p.yearDiscounts["2"] ?? 0} onChange={(e) => setP({ ...p, yearDiscounts: { ...p.yearDiscounts, "2": Number(e.target.value) || 0 } })} style={{ width: 70 }} /></label>
            <label>خصم 3 سنين %<input className="num" value={p.yearDiscounts["3"] ?? 0} onChange={(e) => setP({ ...p, yearDiscounts: { ...p.yearDiscounts, "3": Number(e.target.value) || 0 } })} style={{ width: 70 }} /></label>
            <label>واتساب البائع (طلبات الترقية)<input className="num" dir="ltr" value={p.sellerPhone ?? ""} onChange={(e) => setP({ ...p, sellerPhone: e.target.value || null })} placeholder="09xxxxxxxx" style={{ width: 140 }} /></label>
            <button className="primary" onClick={save}>حفظ</button>
          </div>
          <div className="muted small">«عدد الكاشير»: أجهزة البيع بس. شاشة المطبخ وقارئ الأسعار وتلفون المالك ما يتحسبوش. الترقية في نص السنة: المحل يدفع فرق السعر على الأيام اللي باقية.</div>
          {msg && <div className="notice">{msg}</div>}
          {error && <div className="error">{error}</div>}
        </>
      )}
    </div>
  );
}

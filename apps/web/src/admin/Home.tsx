import { useEffect, useState } from "react";
import { formatMoney, formatQty } from "@pos/shared";
import type { Call } from "./Admin";
import type { Dashboard } from "../owner/Owner";
import { TimeChart } from "./charts";

const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** The owner's first screen: today against yesterday, the week, the month, and what needs attention. */
export function Home({ call, storeId, userName, open }: { call: Call; storeId: string; userName: string; open: (tab: "reports" | "purchasing" | "products" | "alerts" | "customers" | "settings" | "devices" | "staff") => void }) {
  const [d, setD] = useState<Dashboard | null>(null);
  const [expiring, setExpiring] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState<Onboarding | null>(null);
  const [hideStart, setHideStart] = useState(() => {
    try {
      return localStorage.getItem("pos.hideStart") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => void call<Onboarding>("/onboarding").then(setStart).catch(() => setStart(null)), [call]);
  useEffect(() => {
    call<Dashboard>(`/dashboard?storeId=${storeId}`).then(setD).catch((e) => setError((e as Error).message));
    call<unknown[]>(`/stock/expiring?storeId=${storeId}&days=7`).then((r) => setExpiring(r.length)).catch(() => setExpiring(null));
  }, [call, storeId]);
  if (error) return <div className="error">{error}</div>;
  if (!d) return <div className="muted">جاري التحميل…</div>;

  const t = d.today;
  const vs = t.yesterdayUntilNowMinor ? Math.round(((t.totalMinor - t.yesterdayUntilNowMinor) / t.yesterdayUntilNowMinor) * 100) : null;
  const hour = new Date().getHours();
  const hello = hour < 12 ? "صباح الخير" : "مساء الخير";
  const dateLabel = `${DAYS[new Date(`${d.date}T12:00:00Z`).getUTCDay()]} ${d.date.split("-").reverse().join("/")}`;

  return (
    <div className="stack">
      <div className="hello">
        <div>
          <h2>{hello} يا {userName.split(" ")[0]} 👋</h2>
          <span className="muted">{dateLabel}</span>
        </div>
        <span className="spacer" />
        <button className="primary" onClick={() => open("purchasing")}>+ فاتورة توريد</button>
        <button onClick={() => open("products")}>+ بطاقة صنف</button>
        <button onClick={() => open("reports")}>📊 التقارير</button>
      </div>

      {start && !hideStart && <GettingStarted s={start} open={open} hide={() => {
        setHideStart(true);
        try {
          localStorage.setItem("pos.hideStart", "1");
        } catch {
          /* private mode */
        }
      }} />}

      <div className="kpis kpis-hero">
        <div className="kpi hero">
          <span>مبيعات اليوم</span>
          <b className="num">{formatMoney(t.totalMinor)}</b>
          <small>
            {vs === null ? "ما فيش مبيعات أمس لنفس الوقت" : <><span className={vs >= 0 ? "up" : "down"}>{vs >= 0 ? "▲" : "▼"} {Math.abs(vs)}%</span> عن أمس لنفس الساعة ({formatMoney(t.yesterdayUntilNowMinor)})</>}
          </small>
        </div>
        <div className="kpi"><span className="muted">الفواتير</span><b className="num">{t.salesCount}</b><small className="muted">متوسط {formatMoney(t.avgMinor)}</small></div>
        <div className="kpi"><span className="muted">ربح اليوم</span><b className="num ok">{formatMoney(t.profitMinor)}</b><small className="muted">بعد المصروفات {formatMoney(t.netMinor)}</small></div>
        <div className="kpi"><span className="muted">هذا الشهر</span><b className="num">{formatMoney(d.month.totalMinor)}</b><small className="muted">صافي الربح {formatMoney(d.month.netMinor)}</small></div>
      </div>

      <div className="grid-main">
        <div className="card panel">
          <div className="panel-head"><b>آخر 7 أيام</b><span className="spacer" /><button className="ghost" onClick={() => open("reports")}>كل التقارير ←</button></div>
          <TimeChart data={d.week.map((w) => ({ label: DAYS[new Date(`${w.day}T12:00:00Z`).getUTCDay()].replace("ال", ""), values: [w.totalMinor, w.profitMinor] }))} names={["المبيعات", "الربح"]} fmt={formatMoney} height={240} />
        </div>
        <div className="stack">
          <button className="attn" onClick={() => open("alerts")}>
            <span className="attn-icon">🔔</span><span><b>{d.unreadAlerts}</b> تنبيه جديد</span>
          </button>
          <button className={`attn ${d.lowStock.count ? "warn" : ""}`} onClick={() => open("purchasing")}>
            <span className="attn-icon">📉</span><span><b>{d.lowStock.count}</b> صنف قرب يخلص</span>
          </button>
          <button className={`attn ${expiring ? "bad" : ""}`} onClick={() => open("reports")}>
            <span className="attn-icon">⏳</span><span><b>{expiring ?? "—"}</b> صنف صلاحيته تنتهي خلال أسبوع</span>
          </button>
          <button className="attn" onClick={() => open("customers")}>
            <span className="attn-icon">👥</span><span>ديون العملاء <b className="num">{formatMoney(d.customersOweMinor)}</b></span>
          </button>
          <button className="attn" onClick={() => open("purchasing")}>
            <span className="attn-icon">🚚</span><span>علينا للموردين <b className="num">{formatMoney(d.weOweMinor)}</b></span>
          </button>
        </div>
      </div>

      <div className="grid-2">
        <div className="card panel">
          <div className="panel-head"><b>أصناف قربت تخلص</b></div>
          {d.lowStock.items.length === 0 ? <div className="muted">ما فيش نواقص.</div> : (
            <table><tbody>{d.lowStock.items.map((p) => (
              <tr key={`${p.id}-${p.storeName}`}><td>{p.name}</td><td><span className={p.stockMilli <= 0 ? "badge bad" : "badge off"}><span className="num">{formatQty(p.stockMilli, p.weighted)}</span></span></td><td className="muted num">الحد {formatQty(p.minMilli, p.weighted)}</td></tr>
            ))}</tbody></table>
          )}
        </div>
        <div className="card panel">
          <div className="panel-head"><b>الكاشيرات المفتوحة توا</b></div>
          {d.openShifts.length === 0 ? <div className="muted">ما فيش وردية مفتوحة.</div> : (
            <table><tbody>{d.openShifts.map((s) => (
              <tr key={s.id}><td>{s.cashier}<div className="muted">{s.device}</div></td><td className="num muted">{new Date(s.openedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</td><td className="num">في الدرج {formatMoney(s.expectedCashMinor)}</td></tr>
            ))}</tbody></table>
          )}
        </div>
      </div>
    </div>
  );
}

interface Onboarding { businessType: string; steps: Record<"settings" | "products" | "purchases" | "devices" | "staff" | "sales", boolean> }

/** A new shop's first steps, each one a button to the screen that does it; it goes away once done. */
function GettingStarted({ s, open, hide }: { s: Onboarding; open: (tab: "settings" | "products" | "purchasing" | "devices" | "staff") => void; hide: () => void }) {
  const steps: { done: boolean; title: string; hint: string; go: () => void }[] = [
    { done: s.steps.settings, title: "بيانات المحل", hint: "العنوان والهاتف والشعار تطلع في الفاتورة", go: () => open("settings") },
    { done: s.steps.products, title: "ضيف أصنافك", hint: "بطاقة صنف لكل صنف، والباركود يتعمل تلقائياً", go: () => open("products") },
    { done: s.steps.purchases, title: "أول فاتورة توريد", hint: "الكميات والتكلفة وأسعار البيع مرة وحدة", go: () => open("purchasing") },
    { done: s.steps.devices, title: "اعتمد جهاز الكاشير", hint: "هذا الكمبيوتر أو أي جهاز تاني", go: () => open("devices") },
    { done: s.steps.staff, title: "ضيف الكاشيرات", hint: "كل واحد برقم سري وصلاحياته", go: () => open("staff") },
  ];
  const done = steps.filter((x) => x.done).length;
  if (done === steps.length) return null;
  return (
    <div className="card stack getting-started">
      <div className="row">
        <b>🚀 خطوات البداية</b>
        <span className="muted">{done} من {steps.length}</span>
        <span className="spacer" />
        <button className="ghost" onClick={hide}>إخفاء</button>
      </div>
      <div className="progress"><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <div className="start-steps">
        {steps.map((x, i) => (
          <button key={x.title} className={x.done ? "done" : ""} onClick={x.go}>
            <span className="start-n">{x.done ? "✓" : i + 1}</span>
            <span><b>{x.title}</b><small>{x.hint}</small></span>
          </button>
        ))}
      </div>
    </div>
  );
}

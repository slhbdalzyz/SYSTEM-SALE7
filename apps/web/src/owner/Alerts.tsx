import { useEffect, useState } from "react";
import type { Call } from "../admin/Admin";

export interface Alert { id: number; kind: string; title: string; body: string; created_at: string; read_at: string | null; store_name: string | null }

const ICON: Record<string, string> = { low_stock: "📦", out_of_stock: "⛔", big_return: "↩️", big_discount: "🏷️", cash_diff: "💵", over_credit_limit: "📒" };

export function ago(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "توا";
  if (min < 60) return `قبل ${min} دقيقة`;
  const h = Math.round(min / 60);
  if (h < 24) return `قبل ${h} ساعة`;
  return new Date(iso).toLocaleDateString("en-GB");
}

export function Alerts({ call, onRead }: { call: Call; onRead?: (unread: number) => void }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [unread, setUnread] = useState(0);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(before?: number) {
    try {
      const r = await call<{ alerts: Alert[]; unread: number }>(`/alerts${before ? `?before=${before}` : ""}`);
      setAlerts((a) => (before ? [...a, ...r.alerts] : r.alerts));
      setUnread(r.unread);
      setMore(r.alerts.length === 30);
      onRead?.(r.unread);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function readAll() {
    await call("/alerts/read", { body: {} });
    setAlerts((a) => a.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() })));
    setUnread(0);
    onRead?.(0);
  }

  return (
    <div className="stack">
      <div className="row">
        <b>{unread ? `${unread} تنبيه جديد` : "التنبيهات"}</b>
        <span className="spacer" />
        {unread > 0 && <button onClick={readAll}>علّم الكل مقروء</button>}
      </div>
      {error && <div className="error">{error}</div>}
      {alerts.length === 0 && !error && <div className="card muted">ما فيش تنبيهات. لما صنف يقرب يخلص، أو يصير خصم أو مرتجع كبير، أو الدرج ناقص، يظهر هنا.</div>}
      <div className="list card" style={{ padding: 0 }}>
        {alerts.map((a) => (
          <div key={a.id} className={`list-row alert-row${a.read_at ? "" : " unread"}`}>
            <span className="alert-icon" aria-hidden>{ICON[a.kind] ?? "🔔"}</span>
            <div>
              <b>{a.title}</b>
              <div className="small">{a.body}</div>
              <div className="muted small">{ago(a.created_at)}{a.store_name ? ` · ${a.store_name}` : ""}</div>
            </div>
          </div>
        ))}
      </div>
      {more && <button onClick={() => load(alerts[alerts.length - 1].id)}>أقدم</button>}
    </div>
  );
}

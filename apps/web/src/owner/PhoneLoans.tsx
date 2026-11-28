// On the owner's phone: a cashier asking to lend over the limit (yes / no right there), and the
// loans whose day came or passed, with a WhatsApp reminder a tap away.
import { useCallback, useEffect, useState } from "react";
import { fillTemplate, formatMoney, readShopSettings, waLink, type LoanSettings } from "@pos/shared";
import type { Call } from "../admin/Admin";

interface Row { id: string; kind: "loan" | "deposit"; personName: string; phone: string | null; amountMinor: number; leftMinor: number; dueOn: string | null; note: string | null; status: string; overdue: boolean; createdByName: string | null }
interface List { rows: Row[]; totals: { lentMinor: number; heldMinor: number; overdue: number; overdueMinor: number; pending: number } }

const dmy = (s: string | null) => (s ? s.split("-").reverse().join("/") : "");

export function PhoneLoans({ call, shopName }: { call: Call; shopName: string }) {
  const [l, setL] = useState<List | null>(null);
  const [set, setSet] = useState<LoanSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => call<List>("/loans?status=open").then(setL).catch(() => undefined), [call]);
  useEffect(() => {
    void load();
    void call<{ settings: unknown }>("/settings").then((r) => setSet(readShopSettings(r.settings).loans)).catch(() => undefined);
    // A cashier is waiting at the till: look again often.
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => clearInterval(t);
  }, [load, call]);

  if (!l) return null;
  const pending = l.rows.filter((r) => r.status === "pending");
  const late = l.rows.filter((r) => r.overdue);
  if (!pending.length && !late.length && !l.totals.lentMinor && !l.totals.heldMinor) return null;

  async function decide(r: Row, approve: boolean) {
    setBusy(r.id);
    setError(null);
    try {
      await call(`/loans/${r.id}/decide`, { body: { approve } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card stack">
      <b>🤝 السلف والأمانات</b>
      {pending.map((r) => (
        <div key={r.id} className="stack" style={{ gap: 6, border: "1px solid var(--warn)", borderRadius: 12, padding: 10 }}>
          <div><b>{r.createdByName ?? "الكاشير"}</b> يبي يسلّف <b className="num">{formatMoney(r.amountMinor)}</b> لـ <b>{r.personName}</b>{r.note && <span className="muted"> ({r.note})</span>}</div>
          <div className="row" style={{ gap: 8 }}>
            <button disabled={busy === r.id} onClick={() => void decide(r, false)} style={{ flex: 1 }}>✖ لا</button>
            <button className="primary" disabled={busy === r.id} onClick={() => void decide(r, true)} style={{ flex: 1 }}>✔ وافق</button>
          </div>
        </div>
      ))}
      {error && <div className="error">{error}</div>}
      <div className="tiles">
        <div className="tile"><span className="muted">سلف برّا</span><b className="num">{formatMoney(l.totals.lentMinor)}</b></div>
        <div className="tile"><span className="muted">أمانات عندك</span><b className="num">{formatMoney(l.totals.heldMinor)}</b></div>
      </div>
      {late.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="muted">⏰ فات موعدها</span>
          {late.map((r) => (
            <div key={r.id} className="row" style={{ gap: 8 }}>
              <span>{r.personName} <span className="muted small">من {dmy(r.dueOn)}</span></span>
              <span className="spacer" />
              <b className="num">{formatMoney(r.leftMinor)}</b>
              {r.phone && set && (
                <a className="button" target="_blank" rel="noreferrer"
                  href={waLink(r.phone, fillTemplate(set.reminder, { name: r.personName, shop: shopName, what: "سلفة", amount: formatMoney(r.amountMinor), left: formatMoney(r.leftMinor), due: dmy(r.dueOn) }))}>📲</a>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

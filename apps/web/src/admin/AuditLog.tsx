import { useEffect, useState } from "react";
import { formatMoney } from "@pos/shared";
import type { Call } from "./Admin";

interface Row { id: number; created_at: string; action: string; entity: string | null; data: Record<string, unknown> | null; user_name: string | null; device_name: string | null }

/** What each action is called on the page. Unknown ones show as they are. */
export const ACTIONS: Record<string, string> = {
  "user.login": "دخول للإدارة", "user.pin_login": "دخول للكاشير", "user.pin_failed": "رقم سري غلط", "user.2fa_on": "فعّل التحقق بخطوتين",
  "user.2fa_off": "وقّف التحقق بخطوتين", "user.2fa_failed": "رمز تحقق غلط", "user.create": "أضاف موظف", "user.update": "عدّل موظف",
  "product.create": "أضاف صنف", "product.update": "عدّل صنف", "product.price_change": "غيّر سعر", "product.variants": "أضاف مقاسات وألوان", "category.delete": "حذف قسم",
  "sale.discount": "خصم على فاتورة", "sale.return": "مرتجع", "sale.price_mismatch": "سعر مختلف عن السيرفر", "sale.offer_mismatch": "عرض مختلف عن السيرفر",
  "shift.open": "فتح وردية", "shift.close": "قفل وردية", "drawer.open": "فتح الدرج بدون بيع",
  "stock.adjust": "تعديل مخزون", "stock.count": "طبّق جرد", "stock.purchase": "فاتورة توريد", "transfer.send": "أرسل تحويل", "transfer.receive": "استلم تحويل", "transfer.cancel": "ألغى تحويل",
  "customer.create": "أضاف عميل", "customer.payment": "تسديد دين", "customer.credit_limit": "غيّر حد الدين", "customer.over_limit": "تجاوز حد الدين",
  "supplier.create": "أضاف مورد", "supplier.payment": "دفع لمورد", "expense.add": "أضاف مصروف", "expense.delete": "حذف مصروف",
  "money.transfer": "تحويل بين الخزائن", "money.delete": "حذف حركة خزينة", "payroll.delete": "حذف حركة راتب",
  "settings.save": "حفظ الإعدادات", "settings.update": "حفظ الإعدادات", "alerts.settings": "إعدادات التنبيهات", "offer.create": "أضاف عرض", "offer.update": "عدّل عرض",
  "device.register": "ربط جهاز", "device.enable": "فعّل جهاز", "device.disable": "وقّف جهاز", "device.backup": "نسخة احتياطية من الجهاز",
  "store.create": "فتح فرع", "store.enable": "فعّل فرع", "store.disable": "وقّف فرع", "backup.start": "نسخة احتياطية", "backup.restore": "استرجاع نسخة",
  "tenant.register": "تسجيل المحل", "tenant.update": "تعديل المحل", "plan.save": "تغيير الباقة", "payment.record": "دفعة اشتراك", "subscription.paid_online": "دفع الاشتراك أونلاين",
};
const GROUPS: [string, string][] = [["", "الكل"], ["user.", "الدخول والموظفين"], ["product.", "الأصناف والأسعار"], ["sale.", "المبيعات والمرتجعات"], ["shift.", "الورديات"], ["stock.", "المخزون"], ["drawer.", "الدرج"], ["customer.", "العملاء"], ["money.", "الخزينة"], ["settings.", "الإعدادات"]];
const RISKY = new Set(["user.pin_failed", "user.2fa_failed", "drawer.open", "sale.discount", "product.price_change", "sale.return", "customer.over_limit", "stock.adjust", "backup.restore", "user.2fa_off", "sale.price_mismatch"]);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(new Date());

const KEYS: Record<string, string> = {
  items: "أصناف", changed: "اتصلح", name: "الاسم", count: "العدد", qty: "الكمية", reason: "السبب", number: "الرقم", note: "ملاحظة",
  amountMinor: "المبلغ", totalMinor: "الإجمالي", discountMinor: "الخصم", method: "الطريقة", role: "الدور", email: "البريد", limitMinor: "الحد",
};
/** A short, readable line for what an entry carried. */
function detail(r: Row): string {
  const d = r.data;
  if (!d) return "";
  if (Array.isArray(d.priceChanges)) return (d.priceChanges as { unit: string; from: number | null; to: number }[]).map((c) => `${c.unit}: ${c.from === null ? "—" : formatMoney(c.from)} ← ${formatMoney(c.to)}`).join("، ");
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === null || v === undefined || typeof v === "object") continue;
    const label = KEYS[k] ?? k;
    parts.push(/minor$/i.test(k) && typeof v === "number" ? `${label}: ${formatMoney(v)}` : `${label}: ${typeof v === "number" && k === "qty" ? v / 1000 : v}`);
  }
  return parts.slice(0, 5).join(" · ");
}

/** Who did what and when, for the owner: sign-ins, price changes, discounts, returns, stock fixes… */
export function AuditLog({ call }: { call: Call }) {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [userId, setUserId] = useState("");
  const [group, setGroup] = useState("");
  const [data, setData] = useState<{ rows: Row[]; users: { id: string; name: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const qs = new URLSearchParams({ from, to, limit: "500", ...(userId ? { userId } : {}), ...(group ? { action: group } : {}) });
    call<{ rows: Row[]; users: { id: string; name: string }[] }>(`/audit/log?${qs}`).then(setData).catch((e) => setError((e as Error).message));
  }, [call, from, to, userId, group]);

  return (
    <div className="stack">
      <div className="row wrap" style={{ alignItems: "end" }}>
        <label>من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>الموظف
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">الكل</option>
            {data?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
      </div>
      <div className="chips">
        {GROUPS.map(([k, n]) => <button key={k} className={group === k ? "active" : ""} onClick={() => setGroup(k)}>{n}</button>)}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>الوقت</th><th>مين</th><th>العملية</th><th>التفاصيل</th></tr></thead>
          <tbody>
            {data && data.rows.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: "center", padding: 24 }}>ما فيش عمليات في الفترة هذي</td></tr>}
            {data?.rows.map((r) => (
              <tr key={r.id}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{new Date(r.created_at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}</td>
                <td>{r.user_name ?? "—"}{r.device_name && <div className="muted">🖥️ {r.device_name}</div>}</td>
                <td>{RISKY.has(r.action) ? <span className="badge bad">{ACTIONS[r.action] ?? r.action}</span> : ACTIONS[r.action] ?? r.action}</td>
                <td className="audit-data">{detail(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.rows.length >= 500 && <div className="muted">يطلع آخر 500 عملية بس. ضيّق الفترة أو اختار موظف.</div>}
    </div>
  );
}

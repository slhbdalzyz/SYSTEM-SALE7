import { useState } from "react";
import { ORDER_TYPES, ORDER_TYPE_ICONS, ORDER_TYPE_LABELS, QUICK_NOTES, formatMoney, type OrderType } from "@pos/shared";
import type { DiningTable } from "../sync";
import { Modal } from "./dialogs";

/** How this customer's order goes out, and at which table. */
export interface Order { type: OrderType; table?: string | null }

/** Above the cart in a restaurant: eaten in, taken away or delivered, and the table. */
export function OrderBar({ order, setType, pickTable, pending, onKitchen }: {
  order: Order; setType: (t: OrderType) => void; pickTable: () => void; pending: number; onKitchen: () => void;
}) {
  return (
    <div className="order-bar">
      <div className="seg" role="group" aria-label="نوع الطلب">
        {ORDER_TYPES.map((t) => (
          <button key={t} className={order.type === t ? "active" : ""} onClick={() => setType(t)}>{ORDER_TYPE_ICONS[t]} {ORDER_TYPE_LABELS[t]}</button>
        ))}
      </div>
      <button className={order.table ? "table-pick picked" : "table-pick"} onClick={pickTable}>🪑 {order.table ?? "الطاولات"} <kbd>Alt+T</kbd></button>
      <span className="spacer" />
      <button className={pending ? "primary" : ""} disabled={!pending} onClick={onKitchen}>👨‍🍳 للمطبخ{pending ? ` (${pending})` : ""} <kbd>Alt+K</kbd></button>
    </div>
  );
}

/**
 * The floor: each table free or taken (with what is on it so far). A taken table opens its order;
 * a free one starts a new order there.
 */
export function TablesDialog({ tables, busy, onPick, onClose }: {
  tables: DiningTable[]; busy: Map<string, { totalMinor: number; items: number; active: boolean }>; onPick: (t: DiningTable) => void; onClose: () => void;
}) {
  const areas = [...new Set(tables.map((t) => t.area ?? ""))];
  return (
    <Modal title="🪑 الطاولات" onClose={onClose} wide>
      {tables.length === 0 ? (
        <p className="muted">ما فيش طاولات لسا. المالك يضيفها من الإدارة ← «المطعم: الطاولات والوصفات».</p>
      ) : areas.map((a) => (
        <div key={a} className="stack" style={{ gap: 8 }}>
          {areas.length > 1 && <b>{a || "بدون قسم"}</b>}
          <div className="table-grid">
            {tables.filter((t) => (t.area ?? "") === a).map((t) => {
              const b = busy.get(t.name);
              return (
                <button key={t.id} className={`table-tile ${b ? "busy" : ""} ${b?.active ? "active" : ""}`} onClick={() => onPick(t)}>
                  <b>{t.name}</b>
                  {b ? <span className="num">{b.items} · {formatMoney(b.totalMinor)}</span> : <span className="muted">فاضية · {t.seats} كراسي</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="row"><span className="muted">الطاولة المشغولة تفتح طلبها، والفاضية تبدا طلب جديد عليها.</span><span className="spacer" /><button onClick={onClose}>إغلاق</button></div>
    </Modal>
  );
}

/** How the customer wants the dish: tap the usual ones or type it. */
export function NoteDialog({ name, initial, onDone, onClose }: { name: string; initial: string; onDone: (note: string) => void; onClose: () => void }) {
  const [text, setText] = useState(initial);
  const parts = text.split("،").map((x) => x.trim()).filter(Boolean);
  const toggle = (n: string) => setText((parts.includes(n) ? parts.filter((x) => x !== n) : [...parts, n]).join("، "));
  return (
    <Modal title={`📝 ملاحظة على «${name}»`} onClose={onClose}>
      <div className="chips">
        {QUICK_NOTES.map((n) => <button key={n} className={parts.includes(n) ? "active" : ""} onClick={() => toggle(n)}>{n}</button>)}
      </div>
      <label>الملاحظة
        <input autoFocus value={text} maxLength={200} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onDone(text.trim())} placeholder="مثلاً: بدون طماطم" />
      </label>
      <div className="row">
        {initial && <button className="danger" onClick={() => onDone("")}>شيل الملاحظة</button>}
        <span className="spacer" />
        <button onClick={onClose}>إلغاء</button>
        <button className="primary" onClick={() => onDone(text.trim())}>حفظ</button>
      </div>
    </Modal>
  );
}

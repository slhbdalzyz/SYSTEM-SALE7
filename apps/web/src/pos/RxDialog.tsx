import { useState } from "react";
import type { Prescription } from "@pos/shared";
import { Modal } from "./dialogs";

/**
 * A prescription-only medicine in the cart: the cashier looks at the prescription and notes who
 * wrote it. It goes on the sale and in the prescriptions log; without it, the medicine comes out.
 */
export function RxDialog({ initial, items, onSave, onRemove, onClose }: {
  initial: Prescription | null; items: string[]; onSave: (p: Prescription) => void; onRemove: () => void; onClose: () => void;
}) {
  const [p, setP] = useState<Prescription>(initial ?? {});
  const clean = (): Prescription => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, (v ?? "").trim()]).filter(([, v]) => v));
  const any = Object.keys(clean()).length > 0;
  return (
    <Modal title="💊 دواء بوصفة طبية" onClose={onClose}>
      <div className="muted">{items.join("، ")} {items.length > 1 ? "يتباعوا" : "يتباع"} بوصفة بس. شوف الوصفة وسجّل بياناتها:</div>
      <label>اسم الطبيب<input value={p.doctor ?? ""} onChange={(e) => setP({ ...p, doctor: e.target.value })} autoFocus /></label>
      <div className="row">
        <label style={{ flex: 1 }}>رقم الوصفة<input className="num" value={p.number ?? ""} onChange={(e) => setP({ ...p, number: e.target.value })} /></label>
        <label style={{ flex: 1 }}>اسم المريض<input value={p.patient ?? ""} onChange={(e) => setP({ ...p, patient: e.target.value })} /></label>
      </div>
      <div className="row">
        <button className="danger" onClick={onRemove}>ما عندهش وصفة، شيل الدواء</button>
        <span className="spacer" />
        <button className="primary" disabled={!any} onClick={() => onSave(clean())}>شفت الوصفة</button>
      </div>
    </Modal>
  );
}

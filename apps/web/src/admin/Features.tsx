import { useState } from "react";
import { MODULES, MODULE_GROUPS, type ModuleGroup, type ModuleKey, type Modules } from "@pos/shared";
import type { Call } from "./Admin";

/**
 * «⚙️ مميزات المحل»: the owner turns on what the shop needs and puts away what it doesn't.
 * Each kind of shop starts with its own set; turning one off only hides its screens, buttons and
 * fields, and the data stays for when it is turned back on.
 */
export function Features({ call, mods, typeName, onChanged }: { call: Call; mods: Modules; typeName: string; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<ModuleKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flip = async (k: ModuleKey) => {
    setBusy(k);
    setError(null);
    try {
      await call("/settings/modules", { method: "PATCH", body: { [k]: !mods[k] } });
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const on = MODULES.filter((m) => mods[m.key]).length;
  return (
    <div className="stack">
      <h2>🧩 مميزات المحل</h2>
      <div className="hint">
        محلك بدأ بالمميزات اللي يحتاجها أي {typeName}. شغّل اللي تحتاجه وطفّي اللي ما يلزمكش، والشاشات والأزرار والخانات تتبعها في كل مكان: لوحة التحكم، بطاقة الصنف، والكاشير.
        لما تطفي ميزة ما يتمسحش شي: البيانات تقعد، وترجع كيف ما هي لما تشغلها.
      </div>
      <div className="muted">شغالة {on} من {MODULES.length}</div>
      {error && <div className="error">{error}</div>}
      {(Object.keys(MODULE_GROUPS) as ModuleGroup[]).map((g) => (
        <fieldset key={g} className="item-box stack features">
          <legend>{MODULE_GROUPS[g]}</legend>
          {MODULES.filter((m) => m.group === g).map((m) => (
            <label key={m.key} className={`feature ${mods[m.key] ? "on" : ""}`}>
              <span className="feature-icon" aria-hidden>{m.icon}</span>
              <span className="feature-text"><b>{m.label}</b><span className="muted">{m.hint}</span></span>
              <input type="checkbox" role="switch" className="switch" checked={mods[m.key]} disabled={busy !== null} onChange={() => void flip(m.key)} aria-label={m.label} />
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

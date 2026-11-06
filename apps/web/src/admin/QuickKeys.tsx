import { useEffect, useMemo, useState } from "react";
import { QUICK_COLORS, formatMoney, type CatalogProduct, type QuickGroup, type QuickKey } from "@pos/shared";
import { Modal } from "../pos/dialogs";
import { KeyFace, keyInfo, keyStyle, shrinkImage } from "../pos/quickpad";
import type { Call } from "./Admin";

interface Store { id: string; name: string }
interface User { id: string; name: string; role: string; active?: boolean }
interface Suggest { productId: string; name: string; isWeighted: boolean; sales: number }
interface Draft {
  id?: string; productId: string; unitId: string | null; qty: string; openPrice: boolean; label: string; color: string | null; image: string | null;
  groupId: string | null; storeId: string | null; userId: string | null;
}

const blank = (groupId: string | null): Draft => ({ productId: "", unitId: null, qty: "1", openPrice: false, label: "", color: null, image: null, groupId, storeId: null, userId: null });

/**
 * «أزرار الكاشير»: the keys on the till for items sold without a barcode. Drag to order, drop on a
 * group tab to move, tap to edit. Each key can sell a set quantity, ask the price, have a colour or a
 * picture, and be for one branch or one cashier only.
 */
export function QuickKeys({ call, stores }: { call: Call; stores: Store[] }) {
  const [groups, setGroups] = useState<QuickGroup[]>([]);
  const [keys, setKeys] = useState<QuickKey[]>([]);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [suggest, setSuggest] = useState<Suggest[]>([]);
  const [group, setGroup] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [gEdit, setGEdit] = useState<{ id?: string; name: string; color: string | null } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = async () => {
    const r = await call<{ groups: QuickGroup[]; keys: QuickKey[] }>("/quick-keys");
    setGroups(r.groups);
    setKeys(r.keys);
    call<Suggest[]>("/quick-keys/suggest").then(setSuggest).catch(() => setSuggest([]));
  };
  useEffect(() => {
    void load();
    void call<CatalogProduct[]>("/products").then(setProducts);
    void call<User[]>("/users").then(setUsers).catch(() => setUsers([]));
  }, [call]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const shown = keys.filter((k) => (k.groupId ?? null) === group);
  const storeName = (id: string | null) => stores.find((s) => s.id === id)?.name;
  const userName = (id: string | null) => users.find((u) => u.id === id)?.name;

  async function reorder(ids: string[], groupId: string | null) {
    // Shown at once, then saved; a failure reloads what the server has.
    setKeys((ks) => {
      const rest = ks.filter((k) => !ids.includes(k.id));
      const moved = ids.map((id, i) => ({ ...ks.find((k) => k.id === id)!, groupId, sort: i + 1 }));
      return [...rest, ...moved].sort((a, b) => a.sort - b.sort);
    });
    try {
      await call("/quick-keys/order", { body: { groupId, ids } });
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  }

  function dropOnKey(targetId: string) {
    if (!drag || drag === targetId) return;
    const ids = shown.map((k) => k.id).filter((id) => id !== drag);
    ids.splice(ids.indexOf(targetId), 0, drag);
    void reorder(ids, group);
  }

  function dropOnGroup(g: string | null) {
    if (!drag || (keys.find((k) => k.id === drag)?.groupId ?? null) === g) return;
    const ids = [...keys.filter((k) => (k.groupId ?? null) === g).map((k) => k.id), drag];
    void reorder(ids, g);
  }

  function edit(k: QuickKey) {
    setError(null);
    setQ("");
    setDraft({
      id: k.id, productId: k.productId, unitId: k.unitId, qty: String(k.qtyMilli / 1000), openPrice: k.openPrice, label: k.label ?? "", color: k.color, image: k.image,
      groupId: k.groupId, storeId: k.storeId, userId: k.userId,
    });
  }

  async function save() {
    if (!draft) return;
    setError(null);
    const p = byId.get(draft.productId);
    const body = {
      productId: draft.productId, unitId: draft.unitId, groupId: draft.groupId, qtyMilli: Math.max(1, Math.round(Number(draft.qty.replace(",", ".")) * 1000) || 1000),
      openPrice: draft.openPrice, label: draft.label.trim() || null, color: draft.color, image: draft.image, storeId: draft.storeId, userId: draft.userId,
    };
    if (!p) return setError("اختار الصنف");
    try {
      await call(draft.id ? `/quick-keys/${draft.id}` : "/quick-keys", { method: draft.id ? "PATCH" : "POST", body });
      setDraft(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveGroup() {
    if (!gEdit) return;
    setError(null);
    try {
      const g = await call<QuickGroup>(gEdit.id ? `/quick-groups/${gEdit.id}` : "/quick-groups", { method: gEdit.id ? "PATCH" : "POST", body: { name: gEdit.name, color: gEdit.color } });
      setGEdit(null);
      await load();
      setGroup(g.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function moveGroup(id: string, by: number) {
    const ids = groups.map((g) => g.id);
    const i = ids.indexOf(id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setGroups(ids.map((x) => groups.find((g) => g.id === x)!));
    await call("/quick-groups/order", { body: { ids } });
  }

  const picked = draft ? byId.get(draft.productId) : undefined;
  const matches = q.trim() ? products.filter((p) => p.active && p.name.includes(q.trim())).slice(0, 8) : [];
  const preview = draft && picked
    ? keyInfo({ id: "", groupId: null, productId: picked.id, unitId: draft.unitId, qtyMilli: Math.round(Number(draft.qty.replace(",", ".")) * 1000) || 1000, openPrice: draft.openPrice, label: draft.label.trim() || null, color: draft.color, image: draft.image, storeId: null, userId: null, sort: 0 }, picked)
    : null;

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <b>🔘 أزرار الكاشير</b>
          <span className="spacer" />
          <button onClick={() => setGEdit({ name: "", color: null })}>+ مجموعة</button>
          <button className="primary" onClick={() => { setError(null); setQ(""); setDraft(blank(group)); }}>+ زر جديد</button>
        </div>
        <span className="muted">للأصناف اللي تنباع من غير باركود: الخبز، المياه، الأكياس، الخضرة. اسحب الزر لترتيبه، أو حطه على اسم مجموعة لنقله. أول 9 أزرار على الشاشة يشتغلوا من الكيبورد بـ Ctrl+1 لين Ctrl+9.</span>
        <div className="qk-gtabs">
          {[{ id: null as string | null, name: "⭐ الأساسية", color: null as string | null }, ...groups].map((g, i) => (
            <button key={g.id ?? "main"} className={`${group === g.id ? "primary" : ""} ${over === `g:${g.id}` ? "over" : ""}`} style={keyStyle(g.color)}
              onClick={() => setGroup(g.id)}
              onDragOver={(e) => { e.preventDefault(); setOver(`g:${g.id}`); }} onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); setOver(null); dropOnGroup(g.id); }}>
              {g.name} <span className="muted num">({keys.filter((k) => (k.groupId ?? null) === g.id).length})</span>
              {g.id && group === g.id && i > 0 && <>
                <span role="button" title="قدّم" onClick={(e) => { e.stopPropagation(); void moveGroup(g.id!, -1); }}> ▶</span>
                <span role="button" title="أخّر" onClick={(e) => { e.stopPropagation(); void moveGroup(g.id!, 1); }}>◀ </span>
                <span role="button" title="تعديل" onClick={(e) => { e.stopPropagation(); setGEdit({ id: g.id!, name: g.name, color: g.color }); }}>✏️</span>
              </>}
            </button>
          ))}
        </div>
        <div className="qk-admin">
          {shown.map((k, i) => {
            const info = keyInfo(k, byId.get(k.productId));
            return (
              <div key={k.id} className={`qk-tile ${k.color ? "tinted" : ""} ${drag === k.id ? "drag" : ""} ${over === k.id ? "over" : ""}`} style={keyStyle(k.color)}
                draggable onDragStart={() => setDrag(k.id)} onDragEnd={() => { setDrag(null); setOver(null); }}
                onDragOver={(e) => { e.preventDefault(); setOver(k.id); }} onDragLeave={() => setOver(null)}
                onDrop={(e) => { e.preventDefault(); setOver(null); dropOnKey(k.id); }}
                onClick={() => edit(k)} role="button" tabIndex={0} title="اضغط للتعديل، واسحب للترتيب">
                <KeyFace k={k} label={info?.label ?? k.productName ?? "؟"} price={info?.price ?? ""} hotkey={i < 9 ? i + 1 : undefined} />
                <div className="qk-tags">
                  {k.storeId && <span className="badge">🏬 {storeName(k.storeId) ?? "فرع"}</span>}
                  {k.userId && <span className="badge">👤 {userName(k.userId) ?? "كاشير"}</span>}
                  {!info && <span className="badge bad">الصنف موقوف</span>}
                </div>
              </div>
            );
          })}
          <button className="qk-tile qk-add" onClick={() => { setError(null); setQ(""); setDraft(blank(group)); }}>+ زر</button>
        </div>
      </div>

      {suggest.length > 0 && (
        <div className="card stack">
          <b>💡 اقتراحات: الأكثر مبيعاً من غير باركود (آخر 30 يوم)</b>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {suggest.map((s) => (
              <button key={s.productId} onClick={async () => { await call("/quick-keys", { body: { productId: s.productId, groupId: group } }); await load(); }}>
                + {s.name}{s.isWeighted && " ⚖️"} <span className="muted num">({s.sales} فاتورة)</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {error && !draft && !gEdit && <div className="error">{error}</div>}

      {draft && (
        <Modal title={draft.id ? "تعديل الزر" : "زر جديد"} onClose={() => setDraft(null)}>
          {!picked ? (
            <>
              <label>الصنف<input placeholder="اكتب اسم الصنف" value={q} autoFocus onChange={(e) => setQ(e.target.value)} /></label>
              <div className="stack" style={{ gap: 4 }}>
                {matches.map((p) => (
                  <button key={p.id} className="row" onClick={() => setDraft({ ...draft, productId: p.id, unitId: null })}>
                    <span>{p.name}{p.isWeighted && " ⚖️"}</span><span className="spacer" /><span className="num muted">{formatMoney((p.units.find((u) => u.isBase) ?? p.units[0])?.priceMinor ?? 0)}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="row"><b>{picked.name}</b><span className="spacer" /><button className="ghost" onClick={() => setDraft({ ...draft, productId: "", unitId: null })}>تغيير الصنف</button></div>
              <div className="form-grid">
                {picked.units.length > 1 && (
                  <label>العبوة
                    <select value={draft.unitId ?? ""} onChange={(e) => setDraft({ ...draft, unitId: e.target.value || null })}>
                      <option value="">{(picked.units.find((u) => u.isBase) ?? picked.units[0]).name} (الأساسية)</option>
                      {picked.units.filter((u) => !u.isBase).map((u) => <option key={u.id} value={u.id}>{u.name} · {formatMoney(u.priceMinor)}</option>)}
                    </select>
                  </label>
                )}
                <label>{picked.isWeighted ? "الوزن الجاهز (كغ) — 1 يعني يسأل الميزان" : "الكمية بالضغطة"}
                  <input className="num" inputMode="decimal" value={draft.qty} onChange={(e) => setDraft({ ...draft, qty: e.target.value })} />
                </label>
                <label>اسم الزر (اختياري)<input value={draft.label} maxLength={40} placeholder={preview?.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
              </div>
              <label className="check"><input type="checkbox" checked={draft.openPrice} onChange={(e) => setDraft({ ...draft, openPrice: e.target.checked })} /> سعر مفتوح: الكاشير يكتب المبلغ كل مرة (للخضرة المتنوعة وغيرها)</label>
              <label>اللون
                <div className="swatches">
                  <button className={`none ${!draft.color ? "active" : ""}`} onClick={() => setDraft({ ...draft, color: null })} title="بدون">✕</button>
                  {QUICK_COLORS.map((c) => <button key={c} className={draft.color === c ? "active" : ""} style={{ "--sw": c } as React.CSSProperties} onClick={() => setDraft({ ...draft, color: c })} aria-label={c} />)}
                </div>
              </label>
              <label>صورة (اختياري)
                <div className="row">
                  {draft.image && <img src={draft.image} alt="" className="qk-img" />}
                  <input type="file" accept="image/*" style={{ maxWidth: 240 }} onChange={async (e) => { const f = e.target.files?.[0]; if (f) setDraft({ ...draft, image: await shrinkImage(f) }); }} />
                  {draft.image && <button className="ghost" onClick={() => setDraft({ ...draft, image: null })}>شيل الصورة</button>}
                </div>
              </label>
              <div className="form-grid">
                <label>المجموعة
                  <select value={draft.groupId ?? ""} onChange={(e) => setDraft({ ...draft, groupId: e.target.value || null })}>
                    <option value="">⭐ الأساسية</option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </label>
                <label>يطلع في
                  <select value={draft.storeId ?? ""} onChange={(e) => setDraft({ ...draft, storeId: e.target.value || null })}>
                    <option value="">كل الفروع</option>
                    {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label>لمين
                  <select value={draft.userId ?? ""} onChange={(e) => setDraft({ ...draft, userId: e.target.value || null })}>
                    <option value="">كل الكاشيرات</option>
                    {users.filter((u) => u.active !== false).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </label>
              </div>
              {preview && (
                <div className="row"><span className="muted">شكله في الكاشير:</span>
                  <div className="quick-keys"><button className={draft.color ? "tinted" : ""} style={keyStyle(draft.color)}><KeyFace k={draft} label={preview.label} price={preview.price} /></button></div>
                </div>
              )}
            </>
          )}
          {error && <div className="error">{error}</div>}
          <div className="row">
            {draft.id && <button className="danger" onClick={async () => { await call(`/quick-keys/${draft.id}/delete`, { body: {} }); setDraft(null); await load(); }}>حذف الزر</button>}
            <span className="spacer" />
            <button onClick={() => setDraft(null)}>إلغاء</button>
            <button className="primary" disabled={!picked} onClick={save}>حفظ</button>
          </div>
        </Modal>
      )}

      {gEdit && (
        <Modal title={gEdit.id ? "تعديل المجموعة" : "مجموعة جديدة"} onClose={() => setGEdit(null)}>
          <label>الاسم<input value={gEdit.name} autoFocus maxLength={40} placeholder="مثلاً: مخبوزات" onChange={(e) => setGEdit({ ...gEdit, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && gEdit.name.trim() && saveGroup()} /></label>
          <label>اللون
            <div className="swatches">
              <button className={`none ${!gEdit.color ? "active" : ""}`} onClick={() => setGEdit({ ...gEdit, color: null })}>✕</button>
              {QUICK_COLORS.map((c) => <button key={c} className={gEdit.color === c ? "active" : ""} style={{ "--sw": c } as React.CSSProperties} onClick={() => setGEdit({ ...gEdit, color: c })} aria-label={c} />)}
            </div>
          </label>
          {error && <div className="error">{error}</div>}
          <div className="row">
            {gEdit.id && <button className="danger" onClick={async () => { await call(`/quick-groups/${gEdit.id}/delete`, { body: {} }); setGEdit(null); setGroup(null); await load(); }}>حذف المجموعة (الأزرار ترجع للأساسية)</button>}
            <span className="spacer" />
            <button onClick={() => setGEdit(null)}>إلغاء</button>
            <button className="primary" disabled={!gEdit.name.trim()} onClick={saveGroup}>حفظ</button>
          </div>
        </Modal>
      )}
    </div>
  );
}


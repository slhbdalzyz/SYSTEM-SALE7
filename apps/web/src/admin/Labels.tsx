import { useEffect, useMemo, useRef, useState } from "react";
import { LABEL_SIZES, type CatalogProduct } from "@pos/shared";
import { barcodeFits, drawLabel, loadLabelSettings, printLabels, saveLabelSettings, type LabelSettings } from "../hardware/labels";
import { isDesktopApp, listSystemPrinters, serialSupported } from "../hardware/printer";
import type { Call } from "./Admin";

export interface LabelDraft {
  productId: string;
  unitId: string;
  copies: number;
}

interface Row {
  key: string;
  productId: string;
  unitId: string;
  code: string;
  copies: string;
}

export function Labels({ call, storeId, storeName, draft, clearDraft }: { call: Call; storeId: string; storeName: string; draft: LabelDraft[] | null; clearDraft: () => void }) {
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [find, setFind] = useState("");
  const [s, setS] = useState<LabelSettings>(loadLabelSettings);
  const [printers, setPrinters] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  const desktop = isDesktopApp();

  const load = () => call<CatalogProduct[]>(`/products?storeId=${storeId}`).then(setProducts);
  useEffect(() => void load(), [storeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (desktop) void listSystemPrinters().then(setPrinters).catch(() => setPrinters([]));
  }, [desktop]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const rowFor = (p: CatalogProduct, unitId: string, copies: number): Row => {
    const u = p.units.find((x) => x.id === unitId) ?? p.units[0];
    return { key: crypto.randomUUID(), productId: p.id, unitId: u.id, code: u.barcodes[0] ?? "", copies: String(copies) };
  };
  useEffect(() => {
    if (!draft || !products.length) return;
    setRows(draft.flatMap((d) => (byId.get(d.productId) ? [rowFor(byId.get(d.productId)!, d.unitId, d.copies)] : [])));
    clearDraft();
  }, [draft, products]); // eslint-disable-line react-hooks/exhaustive-deps

  const matches = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (q.length < 2) return [];
    return products.filter((p) => p.active && !p.isWeighted && (p.name.toLowerCase().includes(q) || p.units.some((u) => u.barcodes.includes(q)))).slice(0, 8);
  }, [find, products]);

  function add(p: CatalogProduct) {
    const scanned = p.units.find((u) => u.barcodes.includes(find.trim()));
    setRows((rs) => [...rs, rowFor(p, (scanned ?? p.units.find((u) => u.isBase) ?? p.units[0]).id, 1)]);
    setFind("");
  }
  const edit = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const items = rows.flatMap((r) => {
    const p = byId.get(r.productId);
    const u = p?.units.find((x) => x.id === r.unitId);
    if (!p || !u) return [];
    return [{ key: r.key, name: p.units.length > 1 ? `${p.name} (${u.name})` : p.name, unitName: u.name, priceMinor: u.priceMinor, code: r.code, copies: Math.max(0, Math.floor(Number(r.copies) || 0)) }];
  });
  const size = LABEL_SIZES[s.size];

  // Live preview of the first label.
  useEffect(() => {
    const el = preview.current;
    if (!el) return;
    el.innerHTML = "";
    const first = items.find((i) => i.code);
    if (!first) return;
    void document.fonts?.ready.then(() => {
      const c = drawLabel(first, size, { storeName: s.showStore ? storeName : undefined });
      c.style.cssText = `width:${size.widthMm * 4}px;height:${size.heightMm * 4}px;border:1px solid var(--line);border-radius:6px;background:#fff`;
      el.innerHTML = "";
      el.appendChild(c);
    });
  }, [JSON.stringify(items), s.size, s.showStore]); // eslint-disable-line react-hooks/exhaustive-deps

  async function generate(r: Row) {
    setMsg(null);
    try {
      const { code } = await call<{ code: string }>("/barcodes/generate", { body: { unitId: r.unitId } });
      edit(r.key, { code });
      await load();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  async function print() {
    saveLabelSettings(s);
    setMsg(null);
    try {
      await printLabels(items, s, storeName);
      const n = items.reduce((a, i) => a + (i.code ? i.copies : 0), 0);
      if (s.mode !== "browser") setMsg({ text: `تم إرسال ${n} ملصق للطابعة` });
    } catch (e) {
      setMsg({ text: `ما نجحتش: ${(e as Error).message ?? e}`, bad: true });
    }
  }

  const modes: { id: LabelSettings["mode"]; label: string; ok: boolean }[] = [
    { id: "browser", label: "نافذة الطباعة", ok: true },
    { id: "system", label: "طابعة على ويندوز", ok: desktop },
    { id: "network", label: "طابعة شبكة", ok: desktop },
    { id: "serial", label: "منفذ تسلسلي", ok: serialSupported() },
  ];
  const total = items.reduce((a, i) => a + (i.code ? i.copies : 0), 0);

  return (
    <div className="stack">
      <div className="card stack">
        <div style={{ position: "relative" }}>
          <input placeholder="امسح باركود أو اكتب اسم الصنف لإضافته" value={find} onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) add(matches[0]); }} />
          {matches.length > 0 && (
            <div className="results">
              {matches.map((p) => <button key={p.id} onClick={() => add(p)}><span>{p.name}</span></button>)}
            </div>
          )}
        </div>
        {rows.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>الصنف</th><th>الوحدة</th><th>الباركود</th><th>عدد الملصقات</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const p = byId.get(r.productId);
                  const u = p?.units.find((x) => x.id === r.unitId);
                  if (!p || !u) return null;
                  return (
                    <tr key={r.key}>
                      <td>{p.name}</td>
                      <td>
                        <select value={r.unitId} style={{ width: "auto" }} onChange={(e) => { const nu = p.units.find((x) => x.id === e.target.value)!; edit(r.key, { unitId: nu.id, code: nu.barcodes[0] ?? "" }); }}>
                          {p.units.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </select>
                      </td>
                      <td>
                        {u.barcodes.length > 1 ? (
                          <select value={r.code} className="num" style={{ width: "auto" }} onChange={(e) => edit(r.key, { code: e.target.value })}>
                            {u.barcodes.map((b) => <option key={b}>{b}</option>)}
                          </select>
                        ) : r.code ? (
                          <span className="num">{r.code}</span>
                        ) : (
                          <button onClick={() => generate(r)}>توليد باركود</button>
                        )}
                        {r.code && !barcodeFits(r.code, size) && <div className="muted">الباركود صغير على هالمقاس</div>}
                      </td>
                      <td><input className="num" value={r.copies} onChange={(e) => edit(r.key, { copies: e.target.value })} style={{ width: 80 }} /></td>
                      <td><button className="danger" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>✕</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">ضيف الأصناف اللي تبي تطبعلها ملصقات. الصنف اللي ما عندهش باركود تقدر تولّدله واحد من هنا.</p>
        )}
      </div>

      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="card stack" style={{ flex: 1, minWidth: 280 }}>
          <b>طابعة الملصقات</b>
          <div className="row">
            {modes.map((m) => (
              <label key={m.id} className="check" style={{ color: m.ok ? "var(--ink)" : "var(--muted)" }}>
                <input type="radio" disabled={!m.ok} checked={s.mode === m.id} onChange={() => setS({ ...s, mode: m.id })} /> {m.label}
              </label>
            ))}
          </div>
          {s.mode === "system" && (
            <label>الطابعة
              <select value={s.printerName} onChange={(e) => setS({ ...s, printerName: e.target.value })}>
                <option value="">—</option>
                {printers.map((p) => <option key={p}>{p}</option>)}
              </select>
            </label>
          )}
          {s.mode === "network" && (
            <div className="row">
              <label style={{ flex: 2 }}>عنوان IP<input className="num" value={s.host} onChange={(e) => setS({ ...s, host: e.target.value })} /></label>
              <label style={{ flex: 1 }}>المنفذ<input className="num" value={s.port} onChange={(e) => setS({ ...s, port: Number(e.target.value) || 9100 })} /></label>
            </div>
          )}
          {s.mode !== "browser" && (
            <label>نوع الطابعة
              <select value={s.language} onChange={(e) => setS({ ...s, language: e.target.value as LabelSettings["language"] })}>
                <option value="tspl">طابعة ملصقات (Xprinter, TSC, Gprinter…)</option>
                <option value="escpos">طابعة إيصالات حرارية</option>
              </select>
            </label>
          )}
          <label>مقاس الملصق
            <select value={s.size} onChange={(e) => setS({ ...s, size: e.target.value as LabelSettings["size"] })}>
              {Object.keys(LABEL_SIZES).map((k) => <option key={k} value={k}>{k.replace("x", " × ")} مم</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={s.showStore} onChange={(e) => setS({ ...s, showStore: e.target.checked })} /> اسم المحل فوق</label>
          {s.mode !== "browser" && s.language === "tspl" && (
            <label className="check"><input type="checkbox" checked={s.invert} onChange={(e) => setS({ ...s, invert: e.target.checked })} /> الطابعة تطلع الملصق معكوس الألوان (أسود مكان الأبيض)</label>
          )}
        </div>
        <div className="card stack" style={{ alignItems: "center" }}>
          <b>معاينة</b>
          <div ref={preview} />
          {!items.some((i) => i.code) && <span className="muted">تظهر هنا أول ما تضيف صنف عنده باركود</span>}
        </div>
      </div>
      {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
      <div className="row">
        <span className="spacer" />
        <button className="primary big" disabled={!total} onClick={print}>اطبع {total || ""} ملصق</button>
      </div>
    </div>
  );
}

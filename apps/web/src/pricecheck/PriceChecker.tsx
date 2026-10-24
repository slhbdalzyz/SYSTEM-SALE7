import { useEffect, useRef, useState } from "react";
import { formatMoney, formatQty } from "@pos/shared";
import { api } from "../api";
import { db, getMeta, setMeta, storeCatalog } from "../localdb";
import { findByCode, type Hit } from "../lookup";
import { session } from "../session";
import type { Screen } from "../App";

const IDLE_MS = 7000;

/**
 * A tablet with a scanner on the shop floor. It keeps its own copy of the prices, so it keeps
 * working when the internet drops, and refreshes it every few minutes.
 */
export function PriceChecker({ go }: { go: (s: Screen) => void }) {
  const [hit, setHit] = useState<Hit | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [store, setStore] = useState("");
  const [count, setCount] = useState(0);
  const [taps, setTaps] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const refresh = async () => {
      try {
        const r = await api<{ device: { storeName: string }; products: Parameters<typeof storeCatalog>[0] }>("/price-checker/catalog", {
          body: { deviceToken: session.deviceToken },
        });
        await storeCatalog(r.products, true);
        await setMeta("storeName", r.device.storeName);
      } catch (e) {
        if ((e as { status?: number }).status === 401) {
          session.deviceToken = null;
          session.deviceKind = null;
          go("setup");
        }
      }
      setStore((await getMeta<string>("storeName")) ?? "");
      setCount(await db.products.count());
    };
    void refresh();
    const t = setInterval(refresh, 5 * 60_000);
    // The scanner types into whatever has focus; keep it on the hidden field.
    const keep = setInterval(() => input.current?.focus(), 1000);
    return () => {
      clearInterval(t);
      clearInterval(keep);
    };
  }, [go]);

  async function look(code: string) {
    clearTimeout(timer.current);
    const h = await findByCode(code);
    setHit(h);
    setMissing(h ? null : code);
    timer.current = setTimeout(() => {
      setHit(null);
      setMissing(null);
    }, IDLE_MS);
  }

  const base = hit?.unit;
  return (
    <div className="pchecker" onClick={() => input.current?.focus()}>
      <input
        ref={input}
        className="pchecker-input"
        autoFocus
        aria-label="الباركود"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            void look(e.currentTarget.value.trim());
            e.currentTarget.value = "";
          }
        }}
      />
      <header onClick={() => setTaps((n) => (n >= 4 ? (go("setup"), 0) : n + 1))}>{store}</header>
      {!hit && !missing && (
        <div className="pchecker-idle">
          <div style={{ fontSize: "5rem" }}>🔍</div>
          <div>مرّر الباركود تحت القارئ لمعرفة السعر</div>
          <div className="muted" style={{ fontSize: "1rem" }}>{count} صنف</div>
        </div>
      )}
      {missing && (
        <div className="pchecker-idle">
          <div style={{ fontSize: "4rem" }}>🤔</div>
          <div>ما لقيناش الصنف هذا</div>
          <div className="muted num" style={{ fontSize: "1rem" }}>{missing}</div>
        </div>
      )}
      {hit && base && (
        <div className="pchecker-hit">
          <div className="pchecker-name">{hit.product.name}</div>
          {hit.qtyMilli ? (
            <>
              <div className="pchecker-price num">{formatMoney(Math.round((base.priceMinor * hit.qtyMilli) / 1000))}</div>
              <div className="num">{formatQty(hit.qtyMilli, true)} كغ × {formatMoney(base.priceMinor)} للكيلو</div>
            </>
          ) : (
            <>
              <div className="pchecker-price num">{formatMoney(base.priceMinor)}</div>
              <div>{hit.product.isWeighted ? "للكيلو" : `لل${base.name}`}</div>
            </>
          )}
          {hit.product.units.filter((u) => u.id !== base.id).map((u) => (
            <div key={u.id} className="pchecker-other">
              {u.name}: <b className="num">{formatMoney(u.priceMinor)}</b>
              {u.factorMilli > 1000 && (
                <span className="muted"> (الحبة بـ <span className="num">{formatMoney(Math.round((u.priceMinor * 1000) / u.factorMilli))}</span>)</span>
              )}
            </div>
          ))}
        </div>
      )}
      {taps > 0 && <div className="muted" style={{ textAlign: "center" }}>اضغط {5 - taps} مرات للخروج</div>}
    </div>
  );
}

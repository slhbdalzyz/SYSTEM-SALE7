import { useEffect, useRef, useState } from "react";
import { looksLikeBadImei, normSerial, serialsMissing, warrantyLabel } from "@pos/shared";
import { db } from "../localdb";
import type { CartLine } from "./cart";
import { Modal } from "./dialogs";

/**
 * A phone (or anything with its own number) in the cart: the cashier scans the IMEI on the box of
 * each piece sold. It goes on the invoice with the warranty, and the piece leaves the stock list.
 * The numbers in stock show as buttons; a number not on the list is still taken (the shop may not
 * have entered it yet), and the cashier can go on without one, which the owner sees in the log.
 */
export function SerialDialog({ line, taken, onSave, onSkip, onClose }: {
  line: CartLine; taken: string[]; onSave: (serials: string[]) => void; onSkip: () => void; onClose: () => void;
}) {
  const [serials, setSerials] = useState<string[]>(line.serials ?? []);
  const [text, setText] = useState("");
  const [warn, setWarn] = useState<string | null>(null);
  const [stock, setStock] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const pieces = Math.max(1, Math.round(line.qtyMilli / 1000));
  const left = serialsMissing({ qtyMilli: line.qtyMilli, serials });

  useEffect(() => void db.products.get(line.productId).then((p) => setStock(p?.serials ?? [])), [line.productId]);

  function add(raw: string) {
    const s = normSerial(raw);
    setText("");
    input.current?.focus();
    if (s.length < 3) return;
    if (serials.includes(s) || taken.includes(s)) return setWarn(`الرقم ${s} موجود في الفاتورة`);
    if (left <= 0) return setWarn(`الكمية ${pieces} بس. زيد الكمية لو الزبون ياخذ أكثر`);
    setWarn(looksLikeBadImei(s) ? `⚠️ ${s} مش IMEI صحيح، تأكد منه` : stock.length && !stock.includes(s) ? `الرقم ${s} مش في قائمة المخزن، بس انضاف` : null);
    setSerials([...serials, s]);
  }

  const free = stock.filter((s) => !serials.includes(s) && !taken.includes(s));
  return (
    <Modal title="📱 رقم الجهاز (IMEI)" onClose={onClose}>
      <div className="muted">
        {line.name}: {pieces > 1 ? `${pieces} حبات، امسح رقم كل وحدة` : "امسح الرقم اللي على العلبة أو الجهاز"}
        {line.warrantyMonths ? ` · ${warrantyLabel(line.warrantyMonths)}` : ""}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); add(text); }}>
        <input ref={input} className="num" style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} autoFocus placeholder="IMEI أو الرقم التسلسلي" disabled={left <= 0} />
        <button type="submit" disabled={!text.trim() || left <= 0}>إضافة</button>
      </form>
      {warn && <div className="hint">{warn}</div>}
      {serials.length > 0 && (
        <div className="chips">
          {serials.map((s) => (
            <span key={s} className="chip picked num">{s} <button type="button" className="ghost" aria-label="شيل" onClick={() => setSerials(serials.filter((x) => x !== s))}>✕</button></span>
          ))}
        </div>
      )}
      {left > 0 && free.length > 0 && (
        <>
          <div className="muted small">في المخزن ({free.length}):</div>
          <div className="chips">
            {free.slice(0, 30).map((s) => <button key={s} type="button" className="chip num" onClick={() => add(s)}>{s}</button>)}
          </div>
        </>
      )}
      <div className="row">
        <button className="ghost" onClick={onSkip}>كمّل بدون رقم</button>
        <span className="spacer" />
        <span className="muted">{serials.length} من {pieces}</span>
        <button className="primary" disabled={!serials.length} onClick={() => onSave(serials)}>تم</button>
      </div>
    </Modal>
  );
}

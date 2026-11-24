// Shop network (local edition): lets the shop's other devices use the system from this computer,
// over the same Wi-Fi or cable, with no internet: a second till in a browser, the kitchen screen,
// the owner's phone. The QR opens it on a phone.
import { useEffect, useState } from "react";
import qrcode from "qrcode-generator";
import type { Call } from "./Admin";
import { findAgain, leaveClientMode, mainPc } from "../mainPc";

interface Net { lan: boolean; port: number; addresses: string[]; web: boolean }

function Qr({ text }: { text: string }) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return <div style={{ background: "#fff", padding: 8, borderRadius: 8, lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: q.createSvgTag({ cellSize: 4, margin: 2, scalable: false }) }} />;
}

export function LocalNetwork({ call, isOwner }: { call: Call; isOwner: boolean }) {
  return mainPc() ? <SecondTill /> : <MainNetwork call={call} isOwner={isOwner} />;
}

/** On a second till: which main computer it uses, and the way back. */
function SecondTill() {
  const m = mainPc()!;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="card stack">
      <div className="row">
        <h3 style={{ margin: 0 }}>🔗 كاشير ثاني</h3>
        <span className="badge ok">مربوط</span>
      </div>
      <div className="muted">هذا الجهاز يشتغل على الجهاز الرئيسي لـ «{m.shopName}» على <b dir="ltr" className="num">{m.url}</b>. لو تغيّر عنوانه، البرنامج يلقاه بروحه.</div>
      {note && <div className="muted small">{note}</div>}
      <div className="row">
        <button disabled={busy} onClick={async () => { setBusy(true); setNote((await findAgain(true)) ? "لقيناه ✓" : "ما لقيناهش على الشبكة."); setBusy(false); }}>{busy ? "جاري البحث…" : "دوّر عليه من جديد"}</button>
        <span className="spacer" />
        <button className="ghost" disabled={busy} onClick={() => confirm("فك ربط هذا الجهاز بالجهاز الرئيسي؟ البرنامج يعاود يفتح كجهاز مستقل عليه قاعدة بيانات خاصة بيه.") && void leaveClientMode()}>فك الربط</button>
      </div>
    </div>
  );
}

function MainNetwork({ call, isOwner }: { call: Call; isOwner: boolean }) {
  const [n, setN] = useState<Net | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => call<Net>("/local/network").then(setN).catch((e) => setError((e as Error).message));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Only on the main computer itself: a device using it over the network sees its own page.
  if (location.port === "7400" && !["127.0.0.1", "localhost"].includes(location.hostname)) return null;

  async function toggle(lan: boolean) {
    setBusy(true);
    setError(null);
    try {
      await call("/local/network", { method: "PUT", body: { lan } });
      await new Promise((r) => setTimeout(r, 1200)); // the server moves to the new address
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!n) return error ? <div className="error">{error}</div> : null;
  const urls = n.addresses.map((a) => `http://${a}:${n.port}`);
  return (
    <div className="card stack">
      <div className="row">
        <h3 style={{ margin: 0 }}>📶 شبكة المحل</h3>
        <span className={`badge ${n.lan ? "ok" : "off"}`}>{n.lan ? "شغالة" : "مقفولة"}</span>
        <span className="spacer" />
        {isOwner && <button className={n.lan ? "" : "primary"} disabled={busy || !n.web} onClick={() => toggle(!n.lan)}>{busy ? "لحظة…" : n.lan ? "قفل الشبكة" : "تشغيل شبكة المحل"}</button>}
      </div>
      <div className="muted">هذا الجهاز هو الرئيسي: عليه قاعدة البيانات. بالشبكة، باقي أجهزة المحل على نفس الواي فاي أو الكابل تستعمل النظام منه من غير نت: كاشير ثاني من المتصفح، شاشة المطبخ، أو تلفونك.</div>
      {n.lan && (
        <>
          {urls.length ? (
            <div className="row" style={{ alignItems: "start", gap: 24 }}>
              <div className="stack">
                <span>افتح العنوان هذا في متصفح الجهاز الثاني (Chrome):</span>
                {urls.map((u) => <b key={u} className="num" dir="ltr" style={{ fontSize: "1.3rem" }}>{u}</b>)}
                <span className="muted small">ادخل بحساب صاحب المحل، ومن «الأجهزة» اعتمده ككاشير أو شاشة مطبخ. ويندوز ممكن يسألك أول مرة تسمح للبرنامج على الشبكة: اختار «السماح» (Allow).</span>
                <span className="muted small">خلّي هذا الجهاز شغال وقت ما الأجهزة الثانية تخدم. لو طفى، الكاشير الثاني يكمل البيع ويبعته لما يرجع.</span>
                <span className="muted small">💡 كمبيوتر ثاني؟ ركّب عليه برنامج الويندوز واختار «🔗 اربط هذا الجهاز بيه ككاشير ثاني»: يلقى هذا الجهاز بروحه، والطابعة والدرج والميزان يخدموا عليه.</span>
              </div>
              <div className="stack" style={{ alignItems: "center" }}><Qr text={urls[0]} /><small className="muted">امسحه بالتلفون</small></div>
            </div>
          ) : (
            <div className="error">الجهاز مش متصل بأي شبكة. وصّله بالواي فاي أو الكابل.</div>
          )}
        </>
      )}
      {n.lan && (
        <div className="muted small stack" style={{ gap: 4 }}>
          <b>نصايح للشبكة:</b>
          <span>• حط أجهزة المحل على واي فاي غير اللي تعطيه للزبائن، باش ما حد غريب يوصل للنظام.</span>
          <span>• العنوان فوق ممكن يتغير لو الراوتر عاود تشغيل. برنامج الويندوز يلقاه بروحه، أما التلفونات والمتصفح لا. باش يثبت، احجز العنوان لهذا الجهاز من إعدادات الراوتر («DHCP Reservation» أو «حجز عنوان IP»).</span>
          <span>• الأجهزة المتصلة وكم فاتورة عند كل واحد مستنية تتبعث تلقاها في الجدول تحت.</span>
        </div>
      )}
      {!n.web && <div className="muted small">هذه النسخة من البرنامج ما فيهاش ملفات الشبكة. حدّث البرنامج.</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

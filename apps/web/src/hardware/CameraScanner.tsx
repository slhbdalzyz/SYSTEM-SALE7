import { useEffect, useRef, useState } from "react";
import { Modal } from "../pos/dialogs";

interface Detector { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }
type DetectorClass = new (o?: { formats?: string[] }) => Detector;

/** True where the browser can read barcodes from the camera itself (Chrome on Android, Mac, Chromebook). */
export function hasCamera(): boolean {
  return typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
}

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code"];

/**
 * Reads a barcode with the phone's or laptop's camera, for shops without a scanner and for
 * counting stock by phone. Calls onCode once per code; `keepOpen` keeps scanning for the next one.
 */
export function CameraScanner({ onCode, onClose, keepOpen = false, title = "امسح بالكاميرا" }: {
  onCode: (code: string) => void; onClose: () => void; keepOpen?: boolean; title?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(hasCamera() ? null : "المتصفح هذا ما يقراش الباركود بالكاميرا. جرّب Chrome على التلفون.");
  const [last, setLast] = useState<string | null>(null);
  const cb = useRef(onCode);
  cb.current = onCode;

  useEffect(() => {
    if (!hasCamera()) return;
    let stream: MediaStream | null = null;
    let stop = false;
    let seen = "";
    let seenAt = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stop) return stream.getTracks().forEach((t) => t.stop());
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const D = (window as unknown as { BarcodeDetector: DetectorClass }).BarcodeDetector;
        const det = new D({ formats: FORMATS });
        const tick = async () => {
          if (stop) return;
          try {
            const [hit] = await det.detect(v);
            // The same code held in front of the camera counts once, until 2 seconds pass.
            if (hit?.rawValue && (hit.rawValue !== seen || Date.now() - seenAt > 2000)) {
              seen = hit.rawValue;
              seenAt = Date.now();
              setLast(hit.rawValue);
              navigator.vibrate?.(60);
              cb.current(hit.rawValue);
              if (!keepOpen) return;
            }
          } catch {
            /* a frame that couldn't be read */
          }
          setTimeout(tick, 180);
        };
        void tick();
      } catch (e) {
        setError((e as Error).name === "NotAllowedError" ? "اسمح للمتصفح يستخدم الكاميرا وجرّب مرة ثانية" : "ما قدرناش نفتحو الكاميرا");
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [keepOpen]);

  return (
    <Modal title={title} onClose={onClose}>
      {error ? <div className="error">{error}</div> : (
        <div className="camera-box">
          <video ref={video} playsInline muted />
          <div className="camera-aim" />
        </div>
      )}
      {last && <div className="badge ok num" style={{ textAlign: "center" }}>✓ {last}</div>}
      <div className="row"><span className="spacer" /><button onClick={onClose}>{keepOpen ? "تم" : "إلغاء"}</button></div>
    </Modal>
  );
}

// The local edition tells the owner when a new version of the Windows app is out, and installs it
// on a press: a backup first, then the app downloads the signed update, stops the shop's server
// cleanly, and reopens on the new version. Needs the internet only for the download.
import { useEffect, useState } from "react";
import { isDesktopApp } from "../hardware/printer";
import type { Call } from "./Admin";

interface Available { version: string; current: string; notes: string | null }

async function invoke<T>(cmd: string): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd);
}

export function AppUpdate({ call }: { call: Call }) {
  const [u, setU] = useState<Available | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isDesktopApp()) return;
    invoke<Available | null>("check_update").then(setU).catch(() => undefined); // offline: say nothing
  }, []);
  if (!u) return null;

  async function install() {
    setBusy(true);
    setError(null);
    try {
      await call("/local/backup", { method: "POST" }).catch(() => undefined);
      await invoke("install_update");
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  }
  return (
    <div className="notice row">
      <span>🆕 نسخة جديدة من البرنامج متوفرة: <b className="num">{u.version}</b> (عندك {u.current}). بياناتك ما تتأثرش، والنظام ياخذ نسخة احتياطية قبل التحديث.</span>
      <span className="spacer" />
      <button className="primary" disabled={busy} onClick={install}>{busy ? "جاري التحديث… البرنامج بيتقفل ويرجع يفتح" : "حدّث الآن"}</button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

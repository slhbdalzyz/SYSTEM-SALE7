// Phone notifications through the browser's push service. On iPhone they work only after the
// app is added to the home screen (iOS 16.4 and later).
import type { Call } from "../admin/Admin";

export const pushSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function keyBytes(base64url: string): Uint8Array {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function pushEnabled(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(await reg?.pushManager.getSubscription()) && Notification.permission === "granted";
}

export async function enablePush(call: Call, publicKey: string) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("التلفون رفض الإشعارات. فعّلها من إعدادات المتصفح للموقع هذا.");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource }));
  await call("/push/subscribe", { body: sub.toJSON() });
}

export async function disablePush(call: Call) {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await call("/push/unsubscribe", { body: { endpoint: sub.endpoint } }).catch(() => undefined);
  await sub.unsubscribe();
}

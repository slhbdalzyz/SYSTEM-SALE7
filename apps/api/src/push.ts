import webpush from "web-push";
import type { Db } from "./db";
import { setPusher } from "./alerts";

/**
 * Phone notifications go out through the browsers' push services, signed with this server's
 * VAPID keys. They come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set; otherwise the
 * server makes a pair once and keeps it in the database, so push works with no setup.
 */
export async function setupPush(db: Db) {
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    try {
      const saved = (await db.query(`SELECT value FROM platform_settings WHERE key = 'vapid'`)).rows[0]?.value;
      if (saved?.publicKey && saved?.privateKey) {
        ({ publicKey: pub, privateKey: priv } = saved);
      } else {
        const k = webpush.generateVAPIDKeys();
        // Two servers starting at once: the first one's keys win, the other reads them back.
        await db.query(`INSERT INTO platform_settings (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(k)]);
        ({ publicKey: pub, privateKey: priv } = (await db.query(`SELECT value FROM platform_settings WHERE key = 'vapid'`)).rows[0].value);
      }
    } catch (e) {
      console.error("phone notifications are off:", e);
      return setPusher(null, null);
    }
  }
  const subject = process.env.VAPID_SUBJECT ?? (process.env.PLATFORM_ADMIN_EMAIL ? `mailto:${process.env.PLATFORM_ADMIN_EMAIL}` : "mailto:admin@example.com");
  webpush.setVapidDetails(subject, pub!, priv!);
  setPusher(async (to, payload) => {
    try {
      await webpush.sendNotification({ endpoint: to.endpoint, keys: { p256dh: to.p256dh, auth: to.auth } }, payload, { TTL: 6 * 3600, timeout: 5000 });
      return {};
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) return { gone: true };
      throw e;
    }
  }, pub!);
}

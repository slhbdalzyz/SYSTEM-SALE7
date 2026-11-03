// Loaded into the app's service worker: shows the shop's alerts as phone notifications.
self.addEventListener("push", (event) => {
  let d = { title: "تنبيه من المحل", body: "" };
  try {
    d = event.data ? event.data.json() : d;
  } catch {
    d.body = event.data ? event.data.text() : "";
  }
  event.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.body, tag: d.tag, renotify: true, dir: "rtl", lang: "ar",
      icon: "icon-192.png", badge: "icon-192.png", data: { url: "./?view=owner&tab=alerts" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "./", self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          if ("navigate" in c) c.navigate(url).catch(() => undefined);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

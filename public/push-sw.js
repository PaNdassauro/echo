/* eslint-disable */
// Imported by the Workbox-generated service worker via the `importScripts`
// option in vite.config.ts. This ADDS Web Push handling to the existing PWA
// service worker without touching its precache / runtime-caching behavior.
//
// Payload shape sent by the `send-web-push` edge function:
//   { title, body, url, tag, icon, badge }

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { title: "Nova mensagem", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Echo";
  const options = {
    body: data.body || "",
    icon: data.icon || "/echo-icon.png",
    badge: data.badge || "/echo-icon.png",
    tag: data.tag || undefined,
    // Replace an existing notification for the same conversation instead of stacking.
    renotify: Boolean(data.tag),
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Focus an already-open tab and navigate it to the conversation.
        for (const client of clientList) {
          if ("focus" in client) {
            client.focus();
            if ("navigate" in client) client.navigate(targetUrl).catch(() => {});
            return undefined;
          }
        }
        // No tab open — open a fresh one.
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
        return undefined;
      })
  );
});

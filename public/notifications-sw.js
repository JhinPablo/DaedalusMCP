// Cache only a generic offline screen. Never cache chats, API responses or Access pages.
self.addEventListener("install", (event) =>
  event.waitUntil(
    (async () => {
      const cache = await caches.open("daedalus-offline-v1");
      await cache.add("/offline.html");
      await self.skipWaiting();
    })(),
  ),
);
self.addEventListener("fetch", (event) => {
  if (
    event.request.mode === "navigate" &&
    new URL(event.request.url).origin === self.location.origin
  )
    event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html")));
});
self.addEventListener("push", (event) =>
  event.waitUntil(
    (async () => {
      let notice;
      try {
        notice = event.data.json();
        if (typeof notice === "string") notice = JSON.parse(notice);
      } catch {
        notice = {};
      }
      const tabs = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const foreground = tabs.find(
        (tab) => tab.focused && tab.visibilityState === "visible",
      );
      await self.registration.showNotification(notice.title || "Daedalus", {
        body: notice.body || "Hay novedades en tu taller.",
        tag: notice.id || "daedalus-update",
        icon: "/icons/icon-192.png",
        badge: "/icons/badge.png",
        silent: !notice.sound || !!foreground,
        data: { sessionId: notice.sessionId },
      });
      if (foreground)
        foreground.postMessage({ type: "daedalus-notice", id: notice.id });
    })(),
  ),
);
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = tabs.find(
        (tab) => new URL(tab.url).origin === self.location.origin,
      );
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: "daedalus-open-session", sessionId });
      } else
        await self.clients.openWindow(
          "/" + (sessionId ? "#chat/" + encodeURIComponent(sessionId) : ""),
        );
    })(),
  );
});

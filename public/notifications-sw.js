// Notifications only: no response caching, offline copies of chats or forced reloads.
self.addEventListener("install", () => self.skipWaiting());
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

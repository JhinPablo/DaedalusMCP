import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
it("shows push in background and routes a single foreground tone to the focused window", async () => {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const tab = { focused: true, visibilityState: "visible", postMessage: vi.fn() };
  const showNotification = vi.fn();
  const self = {
    addEventListener: (type: string, handler: (event: unknown) => unknown) =>
      handlers.set(type, handler),
    clients: { matchAll: async () => [tab] },
    registration: { showNotification },
    location: { origin: "https://daedalus.test" },
  };
  runInNewContext(await readFile("public/notifications-sw.js", "utf8"), { self, URL });
  let done: Promise<unknown> | undefined;
  const event = {
    data: {
      json: () => ({
        id: "permission:1",
        title: "Permiso",
        body: "Revisar",
        sound: true,
        sessionId: "one",
      }),
    },
    waitUntil: (promise: Promise<unknown>) => (done = promise),
  };
  handlers.get("push")!(event);
  await done;
  expect(showNotification).toHaveBeenLastCalledWith(
    "Permiso",
    expect.objectContaining({
      tag: "permission:1",
      silent: true,
      data: { sessionId: "one" },
    }),
  );
  expect(tab.postMessage).toHaveBeenCalledOnce();
  tab.focused = false;
  handlers.get("push")!(event);
  await done;
  expect(showNotification).toHaveBeenLastCalledWith(
    "Permiso",
    expect.objectContaining({ silent: false }),
  );
  event.data.json = () => ({
    id: "permission:1",
    title: "Permiso",
    body: "Revisar",
    sound: false,
    sessionId: "one",
  });
  handlers.get("push")!(event);
  await done;
  expect(showNotification).toHaveBeenLastCalledWith(
    "Permiso",
    expect.objectContaining({ silent: true }),
  );
});

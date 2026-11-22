import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/web/api", () => ({ request: vi.fn() }));
import { request } from "../src/web/api";
import { subscribePush, unsubscribePush } from "../src/web/pwa";
afterEach(() => vi.unstubAllGlobals());
it("keeps pause after an in-flight subscription update", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const order: string[] = [];
  vi.mocked(request).mockImplementation(async (path) => {
    order.push(path);
    if (path === "/push/key")
      return { publicKey: Buffer.alloc(65, 4).toString("base64url") };
    if (path === "/push/subscribe") await gate;
    return { ok: true };
  });
  const subscription = {
    endpoint: "https://fcm.googleapis.com/test",
    toJSON: () => ({}),
    unsubscribe: vi.fn(async () => true),
  };
  vi.stubGlobal("navigator", {
    serviceWorker: {
      register: async () => {},
      ready: Promise.resolve({
        pushManager: { getSubscription: async () => subscription },
      }),
    },
  });
  const enabled = subscribePush(true);
  await vi.waitFor(() => expect(order).toContain("/push/subscribe"));
  const paused = unsubscribePush();
  expect(order).not.toContain("/push/unsubscribe");
  release();
  await enabled;
  await paused;
  expect(order.at(-1)).toBe("/push/unsubscribe");
  expect(subscription.unsubscribe).toHaveBeenCalledOnce();
});

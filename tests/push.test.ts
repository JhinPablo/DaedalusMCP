import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { PushDelivery, allowedPushEndpoint } from "../src/worker/push";
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");
async function fixture() {
  const db = new DatabaseSync(":memory:"),
    kv = new Map();
  const alarm = vi.fn();
  const storage = {
    sql: {
      exec: (query: string, ...values: Array<string | number>) => {
        const rows = db.prepare(query).all(...values);
        return { toArray: () => rows };
      },
    },
    transaction: async (fn: (t: unknown) => Promise<unknown>) =>
      fn({
        get: async (k: string) => kv.get(k),
        put: async (k: string, v: unknown) => kv.set(k, v),
      }),
    setAlarm: alarm,
  } as unknown as DurableObjectStorage;
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/test",
    expirationTime: null,
    keys: {
      p256dh: b64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
      auth: b64(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
  return { db, push: new PushDelivery(storage), subscription, alarm };
}
it("rejects local endpoints and lookalike hosts", () => {
  for (const url of [
    "http://fcm.googleapis.com/a",
    "https://localhost/x",
    "https://fcm.googleapis.com.evil.test/x",
    "https://127.0.0.1/x",
    "https://fcm.googleapis.com:444/x",
  ])
    expect(allowedPushEndpoint(url)).toBe(false);
  expect(allowedPushEndpoint("https://web.push.apple.com/a")).toBe(true);
});
it("encrypts queued notices, retains keys, deduplicates and removes expired subscriptions", async () => {
  const { db, push, subscription } = await fixture();
  try {
    push.subscribe({ subscription, sound: true });
    expect((await push.keys()).publicKey).toBe((await push.keys()).publicKey);
    const notice = { id: "permission:1", title: "Permiso", body: "Abre Daedalus" };
    push.enqueue([notice, notice]);
    expect(db.prepare("SELECT * FROM push_queue").all()).toHaveLength(1);
    const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("content-encoding")).toBe("aes128gcm");
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^vapid /);
      expect(
        Buffer.from(init!.body as ArrayBuffer).includes(Buffer.from("Abre Daedalus")),
      ).toBe(false);
      return new Response(null, { status: 410 });
    });
    await push.deliver(send as typeof fetch);
    expect(send).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT * FROM push_devices").all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM push_queue").all()).toHaveLength(0);
  } finally {
    db.close();
  }
});
it("persists retry state and cancellation removes pending delivery", async () => {
  const { db, push, subscription, alarm } = await fixture();
  try {
    push.subscribe({ subscription, sound: false });
    push.enqueue([{ id: "task:1", title: "Terminada", body: "Lista" }]);
    await push.deliver(
      vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch,
    );
    expect(db.prepare("SELECT attempts FROM push_queue").get()).toMatchObject({
      attempts: 1,
    });
    expect(alarm).toHaveBeenCalled();
    push.unsubscribe({ endpoint: subscription.endpoint });
    expect(db.prepare("SELECT * FROM push_queue").all()).toHaveLength(0);
  } finally {
    db.close();
  }
});

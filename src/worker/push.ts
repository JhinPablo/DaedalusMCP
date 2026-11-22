import { buildPushPayload, type VapidKeys } from "@block65/webcrypto-web-push";
import { z } from "zod";
import { DomainError } from "../shared/engine";
import type { Notice } from "../web/notifications";

export function allowedPushEndpoint(value: string) {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    [
      "fcm.googleapis.com",
      "updates.push.services.mozilla.com",
      "web.push.apple.com",
      "notify.windows.com",
    ].some(
      (host) =>
        url.hostname === host ||
        (host !== "fcm.googleapis.com" && url.hostname.endsWith("." + host)),
    )
  );
}
const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2048).refine(allowedPushEndpoint),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().regex(/^[\w-]{87}$/),
    auth: z.string().regex(/^[\w-]{22}$/),
  }),
});
const input = z.object({ subscription: subscriptionSchema, sound: z.boolean() });
const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
type Device = { endpoint: string; subscription: string; sound: number };
type Pending = { endpoint: string; id: string; notice: string; attempts: number };
export class PushDelivery {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS push_devices (endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL, sound INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS push_queue (endpoint TEXT NOT NULL,id TEXT NOT NULL,notice TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(endpoint,id))",
    );
  }
  async keys(): Promise<VapidKeys> {
    return this.storage.transaction(async (tx) => {
      const saved = await tx.get<VapidKeys>("push-vapid");
      if (saved) return saved;
      const pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
      const publicKey = new Uint8Array(
        await crypto.subtle.exportKey("raw", pair.publicKey),
      );
      const keys = {
        subject: "https://daedalus.juanpablogranadoscoral.workers.dev",
        publicKey: b64(publicKey),
        privateKey: privateKey.d!,
      };
      await tx.put("push-vapid", keys);
      return keys;
    });
  }
  subscribe(raw: unknown) {
    const { subscription, sound } = input.parse(raw);
    const existing = this.storage.sql
      .exec("SELECT endpoint FROM push_devices WHERE endpoint=?", subscription.endpoint)
      .toArray();
    if (
      !existing.length &&
      this.storage.sql.exec("SELECT endpoint FROM push_devices").toArray().length >= 10
    )
      throw new DomainError(
        409,
        "Máximo de diez dispositivos. Desactiva uno antes de añadir otro.",
      );
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO push_devices VALUES (?,?,?)",
      subscription.endpoint,
      JSON.stringify({
        ...subscription,
        expirationTime: subscription.expirationTime ?? null,
      }),
      sound ? 1 : 0,
    );
  }
  unsubscribe(raw: unknown) {
    const { endpoint } = z.object({ endpoint: z.string().max(2048) }).parse(raw);
    this.storage.sql.exec("DELETE FROM push_devices WHERE endpoint=?", endpoint);
    this.storage.sql.exec("DELETE FROM push_queue WHERE endpoint=?", endpoint);
  }
  enqueue(notices: Notice[], endpoint?: string) {
    if (!notices.length) return false;
    const devices = this.storage.sql
      .exec<Device>("SELECT * FROM push_devices")
      .toArray();
    for (const device of devices) {
      if (endpoint && device.endpoint !== endpoint) continue;
      for (const notice of notices)
        this.storage.sql.exec(
          "INSERT OR IGNORE INTO push_queue(endpoint,id,notice) VALUES (?,?,?)",
          device.endpoint,
          notice.id,
          JSON.stringify(notice),
        );
      this.storage.sql.exec(
        "DELETE FROM push_queue WHERE endpoint=? AND rowid NOT IN (SELECT rowid FROM push_queue WHERE endpoint=? ORDER BY rowid DESC LIMIT 100)",
        device.endpoint,
        device.endpoint,
      );
    }
    return devices.length > 0 && notices.length > 0;
  }
  async deliver(send: typeof fetch = fetch) {
    const pending = this.storage.sql
      .exec<Pending>("SELECT * FROM push_queue LIMIT 50")
      .toArray();
    if (!pending.length) return;
    const keys = await this.keys();
    for (const item of pending) {
      const device = this.storage.sql
        .exec<Device>("SELECT * FROM push_devices WHERE endpoint=?", item.endpoint)
        .toArray()[0];
      let done = !device;
      if (device)
        try {
          const payload = await buildPushPayload(
            {
              data: JSON.stringify({
                ...JSON.parse(item.notice),
                sound: !!device.sound,
              }),
              options: { ttl: 3600 },
            },
            JSON.parse(device.subscription),
            keys,
          );
          const response = await send(item.endpoint, {
            ...payload,
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          done = response.ok || [404, 410].includes(response.status);
          if ([404, 410].includes(response.status))
            this.unsubscribe({ endpoint: item.endpoint });
        } catch {
          /* Retry transient delivery failures without exposing endpoints. */
        }
      if (done || item.attempts >= 4)
        this.storage.sql.exec(
          "DELETE FROM push_queue WHERE endpoint=? AND id=?",
          item.endpoint,
          item.id,
        );
      else
        this.storage.sql.exec(
          "UPDATE push_queue SET attempts=attempts+1 WHERE endpoint=? AND id=?",
          item.endpoint,
          item.id,
        );
    }
    if (this.storage.sql.exec("SELECT id FROM push_queue LIMIT 1").toArray().length)
      await this.storage.setAlarm(Date.now() + 60000);
  }
}

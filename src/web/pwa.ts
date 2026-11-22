import { request } from "./api";
let audio: AudioContext | undefined;
export async function notificationTone() {
  audio ??= new AudioContext();
  await audio.resume();
  const now = audio.currentTime;
  for (const [offset, hz] of [
    [0, 660],
    [0.14, 880],
  ]) {
    const tone = audio.createOscillator(),
      gain = audio.createGain();
    tone.frequency.value = hz;
    gain.gain.setValueAtTime(0, now + offset);
    gain.gain.linearRampToValueAtTime(0.12, now + offset + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.2);
    tone.connect(gain);
    gain.connect(audio.destination);
    tone.start(now + offset);
    tone.stop(now + offset + 0.22);
  }
}
export async function registerPwa() {
  if (!("serviceWorker" in navigator))
    throw new Error("Este navegador no admite instalación PWA.");
  await navigator.serviceWorker.register("/notifications-sw.js", { scope: "/" });
  return await navigator.serviceWorker.ready;
}
let subscriptionOperations: Promise<unknown> = Promise.resolve();
function ordered<T>(operation: () => Promise<T>) {
  const result = subscriptionOperations.then(operation);
  subscriptionOperations = result.catch(() => {});
  return result;
}
export function subscribePush(sound: boolean) {
  return ordered(() => saveSubscription(sound));
}
export function unsubscribePush() {
  return ordered(removeSubscription);
}
async function saveSubscription(sound: boolean) {
  const registration = await registerPwa();
  const { publicKey } = await request<{ publicKey: string }>("/push/key");
  const binary = atob(publicKey.replaceAll("-", "+").replaceAll("_", "/"));
  const key = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    }));
  await request("/push/subscribe", { subscription: subscription.toJSON(), sound });
}
async function removeSubscription() {
  const registration = await registerPwa(),
    subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await request("/push/unsubscribe", { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  }
}
export async function testPush() {
  const registration = await registerPwa(),
    subscription = await registration.pushManager.getSubscription();
  if (!subscription) throw new Error("Activa las notificaciones en este dispositivo.");
  await request("/push/test", { endpoint: subscription.endpoint });
}

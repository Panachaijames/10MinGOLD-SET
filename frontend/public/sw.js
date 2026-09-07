const CACHE_NAME = "aurum-signal-v2";
const APP_SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
      self.clients.claim()
    ])
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Never cache error pages (a 502 from a stopped backend would otherwise shadow the app).
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
  );
});

function showFromPayload(payload) {
  const declarative = payload.notification || {};
  const title = declarative.title || payload.title || "Aurum Signal";
  const options = {
    body: declarative.body || payload.body || "New MACD alert",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    tag: declarative.tag || payload.tag || payload.eventId || payload.deliveryId || "aurum-signal",
    renotify: true,
    data: {
      url: declarative.navigate || payload.url || "/",
      eventId: payload.eventId,
      deliveryId: payload.deliveryId,
      direction: payload.direction
    }
  };
  // A push that does not end in a visible notification gets the subscription revoked on iOS,
  // so showNotification always runs, even for an unparseable payload.
  return self.registration.showNotification(title, options);
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { notification: { title: "Aurum Signal", body: (event.data && event.data.text()) || "New alert" } };
  }

  const receivedAt = new Date().toISOString();
  const tasks = [showFromPayload(payload)];

  if (payload.deliveryId && payload.receiptToken) {
    // The cloud fan-out names its own receipt endpoint; the local FastAPI backend uses /api/push/receipts.
    tasks.push(
      fetch(payload.receiptUrl || "/api/push/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deliveryId: payload.deliveryId,
          receiptToken: payload.receiptToken,
          receivedAt
        })
      }).catch(() => undefined)
    );
  }
  event.waitUntil(Promise.all(tasks));
});

// Browsers occasionally rotate or expire a subscription without the page being open.
// Re-subscribe with the same VAPID key and tell the server which endpoint it replaces.
self.addEventListener("pushsubscriptionchange", (event) => {
  const oldSubscription = event.oldSubscription;
  const applicationServerKey = oldSubscription && oldSubscription.options && oldSubscription.options.applicationServerKey;
  if (!oldSubscription || !applicationServerKey) return;
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey })
      .then((subscription) =>
        fetch("/api/push/subscriptions/rotate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oldEndpoint: oldSubscription.endpoint, subscription: subscription.toJSON() })
        })
      )
      .catch(() => undefined)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(destination);
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(destination) : undefined;
    })
  );
});

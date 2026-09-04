const CACHE_PREFIX = "bens-classes-";
const CACHE = `${CACHE_PREFIX}v5`;

const INDEX_URL = new URL("./index.html", self.location.href).href;
const ROOT_URL = new URL("./", self.location.href).href;
const MANIFEST_URL = new URL("./manifest.json", self.location.href).href;
const ICON_URL = new URL("./app-icon.png", self.location.href).href;
const CLASS_NOTIFICATION_TAG = "bensclasses-class-status";

const CORE_ASSETS = [INDEX_URL, ROOT_URL, MANIFEST_URL, ICON_URL];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // The HTML is the only thing required to render the full schedule.
      // Make that mandatory, while allowing a nonessential asset failure
      // to avoid preventing the entire service worker from installing.
      await cache.add(INDEX_URL);
      await Promise.allSettled(
        CORE_ASSETS
          .filter((url) => url !== INDEX_URL)
          .map((url) => cache.add(url))
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
            .map((key) => caches.delete(key))
        )
      ),
      self.clients.claim()
    ])
  );
});

async function replaceClassNotification(title, body = "", data = {}) {
  // iOS has historically been unreliable about replacing notifications by tag.
  // Explicitly close the prior class-status notification first, then show the
  // replacement with the same tag so only one should remain visible.
  const existing = await self.registration.getNotifications({ tag: CLASS_NOTIFICATION_TAG });
  existing.forEach((notification) => notification.close());

  await self.registration.showNotification(title || "Class Status", {
    body,
    tag: CLASS_NOTIFICATION_TAG,
    icon: ICON_URL,
    badge: ICON_URL,
    data: {
      url: ROOT_URL,
      ...data
    }
  });
}

self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "replace-class-notification") return;

  event.waitUntil(
    (async () => {
      try {
        await replaceClassNotification(
          event.data.title || "Class Status",
          event.data.body || "",
          event.data.data || {}
        );
        event.ports?.[0]?.postMessage({ ok: true });
      } catch (error) {
        event.ports?.[0]?.postMessage({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })()
  );
});

// This is ready for a future Web Push backend. Push payloads can use the same
// replacement path without changing the notification behavior on the phone.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(
    replaceClassNotification(
      payload.title || "Class Status",
      payload.body || "",
      payload.data || {}
    )
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true
      });

      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          return;
        }
      }

      if (self.clients.openWindow) {
        await self.clients.openWindow(event.notification.data?.url || ROOT_URL);
      }
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Page navigations: try the newest HTML while online, but always fall
  // back to our known cached index when the phone has no connection.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);

        try {
          const response = await fetch(request);
          if (response && response.ok) {
            await cache.put(INDEX_URL, response.clone());
            await cache.put(request, response.clone());
          }
          return response;
        } catch (_) {
          const cached =
            (await cache.match(request)) ||
            (await cache.match(INDEX_URL)) ||
            (await cache.match(ROOT_URL));

          if (cached) return cached;

          return new Response(
            "<!doctype html><html><body style='font-family:system-ui;background:#08111f;color:#fff;padding:24px'><h1>Ben's Classes</h1><p>The offline copy has not been saved yet. Open the app once while connected, then it will work offline.</p></body></html>",
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }
      })()
    );
    return;
  }

  // App assets are cache-first so Safari can launch the installed app
  // without Wi-Fi/cellular. Refresh them in the background when possible.
  if (sameOrigin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);

        if (cached) return cached;

        try {
          const response = await fetch(request);
          if (response && response.ok) {
            await cache.put(request, response.clone());
          }
          return response;
        } catch (_) {
          return new Response("", { status: 504, statusText: "Offline" });
        }
      })()
    );
  }

  // Cross-origin requests (currently just the GitHub build-number lookup)
  // are optional. Do not substitute the app HTML when they fail.
});

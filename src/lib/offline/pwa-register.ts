/**
 * Single guarded service worker registration wrapper for WorkTrack.
 *
 * Rules (per WorkTrack Increment F & PWA safety guidelines):
 * - Never registers in dev, inside an iframe, on Lovable preview hostnames, or with ?sw=off.
 * - In refused contexts, unregisters any stale /sw.js registration.
 * - On published/self-hosted origins, registers /sw.js and caches the current pathname
 *   in the Workbox runtime cache so the active page can reopen offline.
 */

const PREVIEW_HOST_SUFFIXES = [".lovable.app", ".gpt-eng.com", ".gptengineer.run"];
const PREVIEW_LABEL_RE = /^(?:id-preview|preview)(?:-[a-z0-9]+)?--.+$/;
const PROJECT_DEV_LABEL_RE = /^project--[a-z0-9-]+-dev$/;

export function isSwRegistrationRefused(options?: {
  isProd?: boolean;
  hostname?: string;
  search?: string;
  inIframe?: boolean;
  delegatedPreviewHost?: string | null;
}): { refused: boolean; reason: string | null } {
  const isProd = options?.isProd ?? import.meta.env.PROD;
  if (!isProd) {
    return { refused: true, reason: "dev_mode" };
  }

  const inIframe =
    options?.inIframe ??
    (typeof window !== "undefined" ? window.self !== window.top : false);
  if (inIframe) {
    return { refused: true, reason: "iframe_context" };
  }

  const search =
    options?.search ?? (typeof window !== "undefined" ? window.location.search : "");
  const params = new URLSearchParams(search);
  if (params.get("sw") === "off") {
    return { refused: true, reason: "kill_switch" };
  }

  const host = (
    options?.hostname ?? (typeof window !== "undefined" ? window.location.hostname : "")
  ).toLowerCase();

  if (
    host === "lovableproject.com" ||
    host.endsWith(".lovableproject.com") ||
    host === "lovableproject-dev.com" ||
    host.endsWith(".lovableproject-dev.com") ||
    host === "beta.lovable.dev" ||
    host.endsWith(".beta.lovable.dev")
  ) {
    return { refused: true, reason: "preview_domain" };
  }

  if (options?.delegatedPreviewHost && host === options.delegatedPreviewHost.toLowerCase()) {
    return { refused: true, reason: "delegated_preview" };
  }

  for (const suffix of PREVIEW_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      const firstLabel = host.slice(0, -suffix.length);
      if (PREVIEW_LABEL_RE.test(firstLabel) || PROJECT_DEV_LABEL_RE.test(firstLabel)) {
        return { refused: true, reason: "preview_subdomain" };
      }
    }
  }

  return { refused: false, reason: null };
}

async function unregisterAppServiceWorkers(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.allSettled(
      registrations
        .filter((reg) => {
          const scriptUrl =
            reg.active?.scriptURL ?? reg.waiting?.scriptURL ?? reg.installing?.scriptURL ?? "";
          return scriptUrl.endsWith("/sw.js");
        })
        .map((reg) => reg.unregister()),
    );
  } catch {
    // Ignore cleanup errors on restricted origins
  }
}

export async function registerWorkTrackServiceWorker(): Promise<{
  registered: boolean;
  reason: string | null;
}> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return { registered: false, reason: "unsupported" };
  }

  const check = isSwRegistrationRefused();
  if (check.refused) {
    await unregisterAppServiceWorkers();
    return { registered: false, reason: check.reason };
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });

    // Cache the current pathname in Workbox's runtime cache so the active screen can reopen offline
    try {
      if ("caches" in window && registration.scope) {
        const cacheName = `workbox-runtime-${registration.scope}`;
        const cache = await caches.open(cacheName);
        const currentPath = window.location.pathname;
        const existing = await cache.match(currentPath);
        if (!existing) {
          await cache.add(currentPath);
        }
      }
    } catch {
      // Non-fatal: runtime caching will still populate on subsequent navigations
    }

    return { registered: true, reason: null };
  } catch {
    return { registered: false, reason: "registration_failed" };
  }
}
/**
 * Link observation: a port of Astro's built-in prefetch triggers
 * (tap/hover/viewport/load strategies and `data-astro-prefetch` semantics)
 * routed into our scheduler instead of browser hints, plus a "proximity"
 * strategy (see proximity.ts) and Next.js's intent upgrade: hovering or
 * touching any prefetchable link schedules it at Intent priority.
 *
 * Differences from Astro's built-in, on purpose:
 *  - no permanent `prefetchedUrls` Set — the cache's TTL is the dedup gate,
 *    so a URL can be prefetched again once its entry goes stale
 *  - skips links the ClientRouter won't intercept anyway
 *    (data-astro-reload, download, target != _self)
 *  - rescans on DOM mutations, so links rendered after page load
 *    (framework islands, mega menus) are picked up
 */

import { isSlowConnection, Priority, schedule } from "./scheduler.js";

export type Strategy = "tap" | "hover" | "viewport" | "load" | "proximity";

export type LinkOptions = {
  defaultStrategy: Strategy;
  prefetchAll: boolean;
};

const HOVER_DEBOUNCE_MS = 80;
const VIEWPORT_DWELL_MS = 300;

const listenedAnchors = new WeakSet<HTMLAnchorElement>();
let opts: LinkOptions;

export function initLinks(options: LinkOptions): void {
  opts = options;
  initTapStrategy();
  initHoverStrategy();
  initViewportStrategy();
  initLoadStrategy();
}

/** Effective strategy for an anchor, or null when it must not be prefetched. */
function strategyOf(el: EventTarget | Element | null): Strategy | null {
  if (!(el instanceof HTMLAnchorElement)) {
    return null;
  }
  if (!el.href) {
    return null;
  }
  // The ClientRouter won't soft-navigate these; prefetching is wasted work.
  if (el.dataset.astroReload !== undefined) {
    return null;
  }
  if (el.hasAttribute("download")) {
    return null;
  }
  if (el.target && el.target !== "_self") {
    return null;
  }

  const attrValue = el.dataset.astroPrefetch;
  if (attrValue === "false") {
    return null;
  }
  // On slow connections every prefetchable link degrades to tap-only.
  if (isSlowConnection() && (attrValue != null || opts.prefetchAll)) {
    return "tap";
  }
  if ((attrValue == null && opts.prefetchAll) || attrValue === "") {
    return opts.defaultStrategy;
  }
  if (
    attrValue === "tap" ||
    attrValue === "hover" ||
    attrValue === "viewport" ||
    attrValue === "load" ||
    attrValue === "proximity"
  ) {
    return attrValue;
  }
  return null;
}

/**
 * Anchors the proximity strategy may prefetch: anything pointer-prefetchable,
 * including links whose strategy IS "proximity" (trajectory as the only
 * pre-hover trigger). Tap-only links are excluded — on slow connections every
 * link degrades to tap, which also turns proximity off for free.
 */
export function isPointerPrefetchable(el: Element): el is HTMLAnchorElement {
  const strategy = strategyOf(el);
  return strategy !== null && strategy !== "tap";
}

function initTapStrategy(): void {
  for (const event of ["touchstart", "mousedown"] as const) {
    document.addEventListener(
      event,
      (e) => {
        const anchor = (e.target as Element | null)?.closest("a");
        // Touching/pressing means navigation is imminent — Intent for any strategy.
        if (anchor && strategyOf(anchor)) {
          schedule(anchor.href, Priority.Intent);
        }
      },
      { passive: true }
    );
  }
}

function initHoverStrategy(): void {
  let timeout = 0;

  function handleHoverIn(href: string): void {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = window.setTimeout(() => {
      schedule(href, Priority.Intent);
    }, HOVER_DEBOUNCE_MS);
  }

  function handleHoverOut(): void {
    if (timeout) {
      clearTimeout(timeout);
      timeout = 0;
    }
  }

  // Hover/focus is an intent signal for every strategy except tap-only links
  // and proximity links — proximity-only mode means the trajectory (or a tap)
  // is the sole trigger, so hover must not prefetch behind its back.
  const hoverable = (el: EventTarget | Element | null) => {
    const strategy = strategyOf(el);
    return strategy !== null && strategy !== "tap" && strategy !== "proximity";
  };

  document.body.addEventListener(
    "focusin",
    (e) => {
      const anchor = (e.target as Element | null)?.closest("a");
      if (anchor && hoverable(anchor)) {
        handleHoverIn(anchor.href);
      }
    },
    { passive: true }
  );
  document.body.addEventListener("focusout", handleHoverOut, {
    passive: true,
  });

  const scan = () => {
    for (const anchor of document.getElementsByTagName("a")) {
      if (listenedAnchors.has(anchor)) {
        continue;
      }
      if (hoverable(anchor)) {
        listenedAnchors.add(anchor);
        anchor.addEventListener(
          "mouseenter",
          (e) => handleHoverIn((e.currentTarget as HTMLAnchorElement).href),
          { passive: true }
        );
        anchor.addEventListener("mouseleave", handleHoverOut, {
          passive: true,
        });
      }
    }
  };
  onPageLoad(scan);
  onDomMutated(scan);
}

function initViewportStrategy(): void {
  let observer: IntersectionObserver | undefined;
  const observedAnchors = new WeakSet<HTMLAnchorElement>();
  const scan = () => {
    for (const anchor of document.getElementsByTagName("a")) {
      if (observedAnchors.has(anchor)) {
        continue;
      }
      if (strategyOf(anchor) === "viewport") {
        observedAnchors.add(anchor);
        observer ??= createViewportIntersectionObserver();
        observer.observe(anchor);
      }
    }
  };
  onPageLoad(scan);
  onDomMutated(scan);
}

function createViewportIntersectionObserver(): IntersectionObserver {
  // Unlike Astro's built-in (which unobserves after the first fire), anchors
  // stay observed — re-entering the viewport re-schedules, so a link whose
  // cache entry went stale gets prefetched again. Fresh entries make repeat
  // fires a no-op via the scheduler's shouldFetch gate.
  const timeouts = new WeakMap<Element, number>();
  return new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const anchor = entry.target as HTMLAnchorElement;
      const timeout = timeouts.get(anchor);
      if (entry.isIntersecting) {
        if (timeout) {
          clearTimeout(timeout);
        }
        timeouts.set(
          anchor,
          window.setTimeout(() => {
            timeouts.delete(anchor);
            schedule(anchor.href, Priority.Default);
          }, VIEWPORT_DWELL_MS)
        );
      } else if (timeout) {
        clearTimeout(timeout);
        timeouts.delete(anchor);
      }
    }
  });
}

function initLoadStrategy(): void {
  onPageLoad(() => {
    for (const anchor of document.getElementsByTagName("a")) {
      if (strategyOf(anchor) === "load") {
        schedule(anchor.href, Priority.Background);
      }
    }
  });
}

/**
 * Fires (debounced to a frame) whenever nodes are added/removed anywhere in
 * the document — catches anchors rendered after page load (framework
 * islands, mega menu panels). Observes documentElement, not body: the body
 * element is replaced on every view-transition swap, which would orphan the
 * observer.
 */
export function onDomMutated(cb: () => void): void {
  let rafId = 0;
  const mo = new MutationObserver(() => {
    if (rafId) {
      return;
    }
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      cb();
    });
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

/** Run now and again after every soft navigation (skips the initial page-load event). */
export function onPageLoad(cb: () => void): void {
  cb();
  let firstLoad = false;
  document.addEventListener("astro:page-load", () => {
    if (!firstLoad) {
      firstLoad = true;
      return;
    }
    cb();
  });
}

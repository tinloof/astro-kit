/**
 * Navigation consumption: the Next.js move. On `astro:before-preparation`
 * we replace `event.loader` so the ClientRouter swaps from our cache:
 *
 *  - fulfilled + fresh  -> parse stored HTML, zero network
 *  - pending            -> await the in-flight prefetch (one request total)
 *  - miss / stale       -> fetch ourselves and ALSO populate the cache, so
 *                          back/forward to this page becomes a hit
 *
 * The consume path mirrors the router's defaultLoader
 * (astro@6.4.x dist/transitions/router.js — re-diff on upgrades):
 * content-type guard, redirect replay into event.to (cross-origin redirect
 * bails out), noscript strip, view-transitions meta check, stylesheet
 * preload (preloadStyleLinks is not exported, replicated below). The
 * dev-only client:only handling is NOT replicated — this module is inert in
 * dev (see index.ts).
 *
 * `doPreparation` awaits `event.loader()` with no try/catch, so the
 * overridden loader must never throw; on abort it returns silently and the
 * router re-checks `event.signal` afterwards.
 */

import type { TransitionBeforePreparationEvent } from "astro:transitions/client";
import {
  type CacheKey,
  type FulfilledEntry,
  fulfill,
  isCacheableResponse,
  keyFor,
  type RejectedEntry,
  readFresh,
  readPending,
  remove,
} from "./cache.js";

const PERSIST_ATTR = "data-astro-transition-persist";
const VT_ENABLED_SELECTOR = '[name="astro-view-transitions-enabled"]';

let parser: DOMParser | undefined;

export function initNavigation(): void {
  document.addEventListener(
    "astro:before-preparation",
    onBeforePreparation as EventListener
  );
}

function onBeforePreparation(event: TransitionBeforePreparationEvent): void {
  if (event.formData) {
    return; // POST navigations never touch the cache
  }
  const key = keyFor(event.to.href);
  if (!key) {
    return;
  }
  const fallback = event.loader; // default loader, already bound to the event

  const fresh = readFresh(key);
  if (fresh) {
    event.loader = async () => {
      if (await consume(event, fresh)) {
        return;
      }
      // Cached document unusable (e.g. no view-transitions meta) — drop it
      // and take the normal network path.
      remove(key);
      if (!event.signal.aborted) {
        await fallback();
      }
    };
    return;
  }

  const pending = readPending(key);
  if (pending) {
    event.loader = async () => {
      const settled = await raceAbort(pending.promise, event.signal);
      if (event.signal.aborted) {
        return;
      }
      if (
        settled?.state === "fulfilled" &&
        Date.now() < settled.staleAt &&
        (await consume(event, settled))
      ) {
        return;
      }
      if (!event.signal.aborted) {
        await fallback();
      }
    };
    return;
  }

  // Miss (stale entries were dropped by readFresh above).
  event.loader = async () => {
    if (await populateAndConsume(event, key)) {
      return;
    }
    if (!event.signal.aborted) {
      await fallback();
    }
  };
}

function consume(
  event: TransitionBeforePreparationEvent,
  entry: FulfilledEntry
): Promise<boolean> {
  const doc = parseDocument(entry.html, entry.mediaType);
  return applyDocument(event, doc, entry.finalUrl);
}

/** Navigation-time fetch that also fills the cache. False -> caller falls back. */
async function populateAndConsume(
  event: TransitionBeforePreparationEvent,
  key: CacheKey
): Promise<boolean> {
  try {
    const res = await fetch(event.to.href, { signal: event.signal });
    const mediaType = (res.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim();
    if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
      return false;
    }
    const html = await res.text();
    const doc = parseDocument(html, mediaType as DOMParserSupportedType);
    if (
      res.status < 500 &&
      isCacheableResponse(res) &&
      doc.querySelector(VT_ENABLED_SELECTOR)
    ) {
      fulfill(key, res, html);
    }
    return await applyDocument(event, doc, res.redirected ? res.url : null);
  } catch {
    return false; // aborted or network error
  }
}

function parseDocument(
  html: string,
  mediaType: DOMParserSupportedType
): Document {
  parser ??= new DOMParser();
  const doc = parser.parseFromString(html, mediaType);
  for (const el of doc.querySelectorAll("noscript")) {
    el.remove();
  }
  return doc;
}

async function applyDocument(
  event: TransitionBeforePreparationEvent,
  doc: Document,
  finalUrl: string | null
): Promise<boolean> {
  if (finalUrl) {
    const redirectedTo = new URL(finalUrl);
    if (redirectedTo.origin !== event.to.origin) {
      return false;
    }
    redirectedTo.hash = event.to.hash;
    event.to = redirectedTo;
  }
  if (!doc.querySelector(VT_ENABLED_SELECTOR)) {
    return false;
  }
  event.newDocument = doc;
  const links = preloadStyleLinks(doc);
  if (links.length && !event.signal.aborted) {
    await Promise.all(links);
  }
  return true;
}

// Replicated from astro@6.4.x dist/transitions/router.js (not exported).
function preloadStyleLinks(newDocument: Document): Promise<unknown>[] {
  const links: Promise<unknown>[] = [];
  for (const el of newDocument.querySelectorAll("head link[rel=stylesheet]")) {
    const href = el.getAttribute("href");
    if (
      href &&
      !document.querySelector(
        `[${PERSIST_ATTR}="${el.getAttribute(PERSIST_ATTR)}"], link[rel=stylesheet][href="${href}"]`
      )
    ) {
      const c = document.createElement("link");
      c.setAttribute("rel", "preload");
      c.setAttribute("as", "style");
      c.setAttribute("href", href);
      links.push(
        new Promise<unknown>((resolve) => {
          for (const evName of ["load", "error"]) {
            c.addEventListener(evName, resolve);
          }
          document.head.appendChild(c);
        })
      );
    }
  }
  return links;
}

/** Resolves (never rejects) with the promise's value, or undefined on abort. */
function raceAbort(
  promise: Promise<FulfilledEntry | RejectedEntry>,
  signal: AbortSignal
): Promise<FulfilledEntry | RejectedEntry | undefined> {
  if (signal.aborted) {
    return Promise.resolve(undefined);
  }
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      signal.addEventListener("abort", () => resolve(undefined), {
        once: true,
      });
    }),
  ]);
}

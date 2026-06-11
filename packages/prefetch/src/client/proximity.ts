/**
 * Proximity strategy: prefetch the link the cursor is heading toward,
 * before the hover happens.
 *
 * How it works, per pointer tick:
 *  1. Keep a short history of pointer positions (sampleWindowMs).
 *  2. Estimate velocity from that window and project the cursor forward
 *     by lookaheadMs — the "where will it be in ~N ms" point.
 *  3. If the segment from the current position to the projected point
 *     crosses a prefetchable link's rect (inflated by radiusPx), schedule
 *     that link at Intent priority.
 *
 * Compared to the hover strategy (80ms debounce after mouseenter), this
 * typically starts the request ~lookaheadMs + debounce earlier. The
 * scheduler's TTL/pending dedup makes mispredictions cheap: worst case is
 * one speculative request for a link the cursor never reaches.
 *
 * Candidate set is viewport-visible prefetchable anchors only (tracked via
 * IntersectionObserver), so the per-tick hit test stays O(visible links).
 */

import { isPointerPrefetchable, onDomMutated, onPageLoad } from "./links.js";
import { Priority, schedule } from "./scheduler.js";

export type ProximityOptions = {
  /**
   * How far ahead (ms) to project the cursor along its current velocity.
   * The "how early" knob: larger values prefetch sooner but predict less
   * accurately.
   */
  lookaheadMs: number;
  /**
   * Ignore pointer movement faster than this (px/s). Flicks overshoot;
   * prefetching everything along their path is wasted bandwidth.
   */
  maxSpeedPxS: number;
  /**
   * Ignore pointer movement slower than this (px/s). Slow drift means the
   * pointer is already near its target — the hover strategy covers that.
   */
  minSpeedPxS: number;
  /**
   * Extra hit area (px) around each link's rect. Larger triggers earlier
   * for near-miss trajectories; 0 requires the projected path to actually
   * cross the link.
   */
  radiusPx: number;
  /**
   * Pointer-history window (ms) used to estimate velocity. Shorter reacts
   * faster to direction changes; longer smooths jitter.
   */
  sampleWindowMs: number;
  /** Evaluate trajectories at most once per this many ms. */
  tickMs: number;
};

export const PROXIMITY_DEFAULTS: ProximityOptions = {
  lookaheadMs: 150,
  sampleWindowMs: 80,
  radiusPx: 64,
  minSpeedPxS: 80,
  maxSpeedPxS: 2500,
  tickMs: 50,
};

/** Fired (on document) for every link the predictor decides to prefetch. */
export const PROXIMITY_HIT_EVENT = "astro-prefetch:proximity-hit";

export type ProximityHitDetail = {
  anchor: HTMLAnchorElement;
  href: string;
};

type Sample = {
  t: number;
  x: number;
  y: number;
};

const samples: Sample[] = [];
/** Prefetchable anchors currently in the viewport — the hit-test candidates. */
const visible = new Set<HTMLAnchorElement>();
const rects = new Map<HTMLAnchorElement, DOMRect>();
let observedAnchors = new WeakSet<HTMLAnchorElement>();
let rectsDirty = true;
let lastEvalAt = 0;
let evalTimer = 0;
let observer: IntersectionObserver | null = null;
let opts: ProximityOptions = PROXIMITY_DEFAULTS;
let enabled = false;

/**
 * Enable + tune the predictor, or `false` to pause it. Safe to call again
 * at runtime (see configure() in index.ts): observers are wired once;
 * subsequent calls just merge options.
 */
export function setProximity(config: Partial<ProximityOptions> | false): void {
  if (config === false) {
    enabled = false;
    return;
  }
  opts = { ...opts, ...config };
  enabled = true;
  if (observer) {
    return;
  }

  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        visible.add(entry.target as HTMLAnchorElement);
      } else {
        visible.delete(entry.target as HTMLAnchorElement);
      }
    }
    rectsDirty = true;
  });

  onPageLoad(fullRescan);
  // Anchors rendered after page load (mega menu panels, framework islands)
  // join the candidate set as soon as they hit the DOM.
  onDomMutated(observeNewAnchors);
  document.addEventListener("pointermove", onPointerMove, { passive: true });
  // Rects are viewport-relative — any scroll (window or nested) or resize
  // invalidates them. Recomputed lazily on the next evaluation tick.
  document.addEventListener("scroll", markRectsDirty, {
    passive: true,
    capture: true,
  });
  window.addEventListener("resize", markRectsDirty);
}

/** The swap replaced the body: previous anchors are gone. Re-observe from
 *  scratch so `visible` never holds detached nodes. */
function fullRescan(): void {
  if (!observer) {
    return;
  }
  observer.disconnect();
  visible.clear();
  rects.clear();
  rectsDirty = true;
  observedAnchors = new WeakSet();
  observeNewAnchors();
}

/** Incremental: only anchors not seen before — cheap enough to run on every
 *  (frame-debounced) DOM mutation. */
function observeNewAnchors(): void {
  if (!observer) {
    return;
  }
  for (const anchor of document.getElementsByTagName("a")) {
    if (observedAnchors.has(anchor)) {
      continue;
    }
    if (isPointerPrefetchable(anchor)) {
      observedAnchors.add(anchor);
      observer.observe(anchor);
    }
  }
}

function markRectsDirty(): void {
  rectsDirty = true;
}

function onPointerMove(e: PointerEvent): void {
  if (e.pointerType === "touch") {
    return;
  }
  const now = performance.now();
  samples.push({ t: now, x: e.clientX, y: e.clientY });
  // Keep only the velocity window (plus one older sample as the baseline).
  const cutoff = now - opts.sampleWindowMs;
  while (samples.length > 2 && samples[1].t < cutoff) {
    samples.shift();
  }

  const sinceLast = now - lastEvalAt;
  if (sinceLast >= opts.tickMs) {
    lastEvalAt = now;
    evaluate();
  } else if (!evalTimer) {
    // Trailing tick so a burst of moves still ends with one evaluation.
    evalTimer = window.setTimeout(() => {
      evalTimer = 0;
      lastEvalAt = performance.now();
      evaluate();
    }, opts.tickMs - sinceLast);
  }
}

export type ProximityTrajectory = {
  /** Within the min/max speed gates — only active trajectories prefetch. */
  active: boolean;
  aheadX: number;
  aheadY: number;
  speed: number;
  x: number;
  y: number;
};

function currentTrajectory(): ProximityTrajectory | null {
  if (samples.length < 2) {
    return null;
  }
  const first = samples[0];
  const last = samples.at(-1) as Sample;
  // Pointer stopped — the stale window would report a frozen velocity.
  if (performance.now() - last.t > opts.sampleWindowMs * 2) {
    return null;
  }
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) {
    return null;
  }
  const vx = (last.x - first.x) / dt;
  const vy = (last.y - first.y) / dt;
  const speed = Math.hypot(vx, vy);
  return {
    x: last.x,
    y: last.y,
    aheadX: last.x + vx * (opts.lookaheadMs / 1000),
    aheadY: last.y + vy * (opts.lookaheadMs / 1000),
    speed,
    active: speed >= opts.minSpeedPxS && speed <= opts.maxSpeedPxS,
  };
}

function evaluate(): void {
  if (!enabled || visible.size === 0) {
    return;
  }
  const traj = currentTrajectory();
  if (!traj?.active) {
    return;
  }

  if (rectsDirty) {
    refreshRects();
  }
  const segment: Segment = {
    x1: traj.x,
    y1: traj.y,
    x2: traj.aheadX,
    y2: traj.aheadY,
  };
  for (const [anchor, rect] of rects) {
    if (segmentIntersectsRect(segment, rect, opts.radiusPx)) {
      // Debug overlay flashes the predicted target on this event. Carries
      // the element, not just the href: several links can share a URL and
      // only the rect actually crossed should light up.
      document.dispatchEvent(
        new CustomEvent<ProximityHitDetail>(PROXIMITY_HIT_EVENT, {
          detail: { href: anchor.href, anchor },
        })
      );
      // schedule() dedups against fresh/pending/queued entries, so repeat
      // hits while the cursor travels are free.
      schedule(anchor.href, Priority.Intent);
    }
  }
}

export type ProximityDebugInfo = {
  candidates: { anchor: HTMLAnchorElement; href: string; rect: DOMRect }[];
  options: ProximityOptions;
  trajectory: ProximityTrajectory | null;
};

/**
 * Snapshot for the debug overlay (see debug.ts), called once per frame while
 * the overlay runs. Always re-measures: the lazy cache only invalidates on
 * scroll/resize/mutations, so it drifts on layout shifts those don't cover
 * (hover transforms, font swaps) — the overlay must show true positions.
 */
export function getProximityDebugInfo(): ProximityDebugInfo {
  refreshRects();
  const candidates: ProximityDebugInfo["candidates"] = [];
  for (const [anchor, rect] of rects) {
    candidates.push({ anchor, href: anchor.href, rect });
  }
  return { options: opts, trajectory: currentTrajectory(), candidates };
}

function refreshRects(): void {
  rects.clear();
  for (const anchor of visible) {
    // A removed anchor (closed mega menu) may not have produced its final
    // not-intersecting entry yet; its rect would be 0,0,0,0 — a phantom
    // target at the viewport origin.
    if (!anchor.isConnected) {
      visible.delete(anchor);
      continue;
    }
    rects.set(anchor, anchor.getBoundingClientRect());
  }
  rectsDirty = false;
}

/**
 * One Liang–Barsky clip step against a single slab edge. Returns the
 * narrowed [t0, t1] window, or null when the segment is fully outside this
 * edge.
 */
function clipEdge(
  p: number,
  q: number,
  t0: number,
  t1: number
): [number, number] | null {
  if (p === 0) {
    return q < 0 ? null : [t0, t1];
  }
  const t = q / p;
  if (p < 0) {
    if (t > t1) {
      return null;
    }
    return [Math.max(t, t0), t1];
  }
  if (t < t0) {
    return null;
  }
  return [t0, Math.min(t, t1)];
}

type Segment = { x1: number; y1: number; x2: number; y2: number };

/** Liang–Barsky segment / axis-aligned-rect test, rect inflated by `pad`. */
function segmentIntersectsRect(
  seg: Segment,
  rect: DOMRect,
  pad: number
): boolean {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const edges: [number, number][] = [
    [-dx, seg.x1 - (rect.left - pad)],
    [dx, rect.right + pad - seg.x1],
    [-dy, seg.y1 - (rect.top - pad)],
    [dy, rect.bottom + pad - seg.y1],
  ];
  let window: [number, number] | null = [0, 1];
  for (const [p, q] of edges) {
    window = clipEdge(p, q, window[0], window[1]);
    if (!window) {
      return false;
    }
  }
  return true;
}

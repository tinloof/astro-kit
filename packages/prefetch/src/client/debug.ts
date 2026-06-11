/**
 * Debug visuals, enabled via the integration's `debug` option and loaded
 * dynamically — zero bytes in the client bundle when disabled:
 *
 *  - badge: classifies each soft navigation (hit / awaited prefetch / miss)
 *    on `astro:before-preparation` and renders after `astro:page-load`
 *    with elapsed ms
 *  - overlay: full-viewport canvas showing each candidate link's hit area
 *    (rect inflated by radiusPx), the cursor's velocity ray out to the
 *    projected point, a live px/s readout, and a green flash on the link
 *    the predictor just prefetched. Ray is red while within the speed
 *    gates (prediction live), gray when too slow/fast.
 */

import type { TransitionBeforePreparationEvent } from "astro:transitions/client";
import { get, keyFor } from "./cache.js";
import {
  getProximityDebugInfo,
  PROXIMITY_HIT_EVENT,
  type ProximityHitDetail,
  type ProximityTrajectory,
} from "./proximity.js";

export type DebugOptions = {
  badge: boolean;
  overlay: boolean;
};

const FLASH_MS = 600;

export function initDebug(options: DebugOptions): void {
  if (options.badge) {
    initBadge();
  }
  if (options.overlay) {
    initProximityOverlay();
  }
}

type Status = "hit" | "await" | "miss" | "direct";

let navStart = 0;
let lastStatus: Status = "direct";

function initBadge(): void {
  document.addEventListener("astro:before-preparation", ((
    event: TransitionBeforePreparationEvent
  ) => {
    navStart = performance.now();
    const key = keyFor(event.to.href);
    const entry = key ? get(key) : undefined;
    if (entry?.state === "fulfilled" && Date.now() < entry.staleAt) {
      lastStatus = "hit";
    } else if (entry?.state === "pending") {
      lastStatus = "await";
    } else {
      lastStatus = "miss";
    }
  }) as EventListener);

  document.addEventListener("astro:page-load", () => {
    const ms = navStart ? Math.round(performance.now() - navStart) : 0;
    renderBadge(lastStatus, ms);
    navStart = 0;
    lastStatus = "direct";
  });
}

function renderBadge(status: Status, ms: number): void {
  let el = document.getElementById("astro-prefetch-badge");
  if (!el) {
    el = document.createElement("div");
    el.id = "astro-prefetch-badge";
    document.body.appendChild(el);
  }
  const theme = {
    hit: { bg: "#dcfce7", fg: "#166534", label: "● CACHE HIT" },
    await: { bg: "#dbeafe", fg: "#1e40af", label: "◐ AWAITED PREFETCH" },
    miss: { bg: "#fef3c7", fg: "#92400e", label: "○ CACHE MISS" },
    direct: { bg: "#e2e8f0", fg: "#334155", label: "— DIRECT" },
  }[status];
  el.style.cssText =
    "position:fixed;bottom:1rem;right:1rem;z-index:9999;" +
    "padding:0.5rem 0.85rem;border-radius:999px;" +
    "font:700 0.8rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;" +
    "box-shadow:0 6px 20px rgba(15,23,42,0.18);" +
    `background:${theme.bg};color:${theme.fg};`;
  el.textContent = `${theme.label} · ${ms}ms`;
}

function initProximityOverlay(): void {
  const canvas = document.createElement("canvas");
  canvas.id = "astro-prefetch-proximity-overlay";
  // width/height 100% is required: canvas is a replaced element, so unlike
  // a div, inset:0 alone does NOT stretch it — it stays at its intrinsic
  // bitmap size (a small box at the top-left).
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;z-index:9998;pointer-events:none;";
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  // Child of <html>, not <body> — the body is replaced on every swap.
  document.documentElement.appendChild(canvas);

  // Keyed by the anchor element, not href: several links can share a URL
  // and only the rect the trajectory actually crossed should flash.
  const flashes = new WeakMap<HTMLAnchorElement, number>();
  document.addEventListener(PROXIMITY_HIT_EVENT, ((
    e: CustomEvent<ProximityHitDetail>
  ) => {
    flashes.set(e.detail.anchor, performance.now() + FLASH_MS);
  }) as EventListener);

  // Size the bitmap to the canvas's own box, not innerWidth/innerHeight:
  // those include the scrollbar while a fixed inset:0 element does not,
  // which would scale the bitmap down and skew every drawn coordinate.
  let cssWidth = 0;
  let cssHeight = 0;
  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const box = canvas.getBoundingClientRect();
    cssWidth = box.width;
    cssHeight = box.height;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  const draw = () => {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    const { options, trajectory, candidates } = getProximityDebugInfo();
    const now = performance.now();

    for (const { anchor, rect } of candidates) {
      const flashUntil = flashes.get(anchor) ?? 0;
      const flash = flashUntil > now ? (flashUntil - now) / FLASH_MS : 0;
      drawCandidate(ctx, rect, options.radiusPx, flash);
    }
    if (trajectory) {
      drawTrajectory(ctx, trajectory);
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

/** `flash` is 1 right after a predictor hit and fades to 0 over FLASH_MS. */
function drawCandidate(
  ctx: CanvasRenderingContext2D,
  rect: DOMRect,
  radius: number,
  flash: number
): void {
  const x = rect.left - radius;
  const y = rect.top - radius;
  const w = rect.width + radius * 2;
  const h = rect.height + radius * 2;
  if (flash > 0) {
    ctx.fillStyle = `rgba(22,163,74,${0.3 * flash})`;
    ctx.fillRect(x, y, w, h);
  }
  ctx.strokeStyle = flash > 0 ? "rgba(22,163,74,0.9)" : "rgba(79,70,229,0.25)";
  ctx.lineWidth = flash > 0 ? 2 : 1;
  ctx.strokeRect(x, y, w, h);
}

function drawTrajectory(
  ctx: CanvasRenderingContext2D,
  traj: ProximityTrajectory
): void {
  const color = traj.active ? "rgba(220,38,38,0.9)" : "rgba(100,116,139,0.55)";
  // Velocity ray: cursor to projected (lookaheadMs-ahead) point.
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(traj.x, traj.y);
  ctx.lineTo(traj.aheadX, traj.aheadY);
  ctx.stroke();
  // Projected point.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(traj.aheadX, traj.aheadY, 4, 0, Math.PI * 2);
  ctx.fill();
  // Speed readout near the cursor.
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillText(`${Math.round(traj.speed)}px/s`, traj.x + 12, traj.y - 12);
}

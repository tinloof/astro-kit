import type { AstroIntegration } from "astro";

// Fixes the back button not working in iOS Chrome/Edge due to ClientRouter
// intercepting popstate events that those browsers rely on for back navigation.
//
// Injected as an inline head script so it executes during parse, before the
// deferred ClientRouter module registers its own click listener — our listener
// always runs first, regardless of where the integration is added.
const script = `
document.addEventListener("click", (e) => {
  // Only iOS Chrome/Edge have the ClientRouter back-nav bug.
  if (!/CriOS|EdgiOS/i.test(navigator.userAgent)) return;
  // Leave modified / non-primary / already-handled clicks alone.
  if (
    e.defaultPrevented ||
    e.button !== 0 ||
    e.metaKey ||
    e.ctrlKey ||
    e.shiftKey ||
    e.altKey
  )
    return;
  const link = e.target instanceof Element ? e.target.closest("a") : null;
  if (
    !link ||
    link.target === "_blank" ||
    link.hasAttribute("download") ||
    link.hasAttribute("data-astro-reload") ||
    !link.href.startsWith(window.location.origin) ||
    link.href.includes("#")
  )
    return;
  // Plant the entry synchronously (inside the user gesture) so WebKit
  // keeps it non-skippable. Give it Astro-shaped state with a monotonic
  // index: ClientRouter's onPopState bails on a null state, so a null
  // entry makes back navigation silently do nothing at any depth > 1.
  // We don't dispatch a synthetic popstate — ClientRouter's own click
  // handler does the forward swap (it skips re-pushing since the URL
  // already matches), and a synthetic popstate would double-swap.
  const index =
    (typeof history.state?.index === "number" ? history.state.index : 0) + 1;
  history.pushState({ index, scrollX: 0, scrollY: 0 }, "", link.href);
});
`;

export default function iosBackNavFix(): AstroIntegration {
  return {
    name: "@tinloof/astro-ios-backnav-fix",
    hooks: {
      "astro:config:setup": ({ injectScript }) => {
        injectScript("head-inline", script);
      },
    },
  };
}

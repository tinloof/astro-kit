# @tinloof/astro-ios-backnav-fix

Astro integration that fixes the back button not working in iOS Chrome (`CriOS`) and iOS Edge (`EdgiOS`) when using [`<ClientRouter />`](https://docs.astro.build/en/guides/view-transitions/) view transitions.

## The problem

On iOS, Chrome and Edge rely on `popstate` events for back navigation. Astro's `ClientRouter` intercepts link clicks and manages history itself, but the entries it pushes can leave those browsers with a `null` history state. `ClientRouter`'s `onPopState` bails on a `null` state, so pressing back silently does nothing at any history depth greater than 1.

## The fix

An inline head script that, on link clicks in affected browsers only, synchronously pushes an Astro-shaped history entry (with a monotonic `index`) inside the user gesture so WebKit keeps it non-skippable. `ClientRouter`'s own click handler still does the forward swap — it skips re-pushing since the URL already matches.

The script is injected with `injectScript("head-inline", ...)`, so it executes during document parse — always before the deferred `ClientRouter` module registers its listeners, regardless of integration order.

## Install

```bash
pnpm add @tinloof/astro-ios-backnav-fix
```

## Usage

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import iosBackNavFix from "@tinloof/astro-ios-backnav-fix";

export default defineConfig({
  integrations: [iosBackNavFix()],
});
```

Requires a site using `<ClientRouter />` from `astro:transitions` — it's a no-op for regular MPA navigation (the script only acts in iOS Chrome/Edge, and without `ClientRouter` the browser handles history natively anyway... but there's no reason to ship it).

## What it leaves alone

- Modified clicks (meta/ctrl/shift/alt), non-primary buttons, `defaultPrevented`
- `target="_blank"`, `download`, `data-astro-reload` links
- External links and same-page hash links

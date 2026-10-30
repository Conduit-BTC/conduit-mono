# App scroll containment

Desktop Merchant owns a viewport-height workspace. Its main panel and sidebar
scroll independently; the document must not acquire a second scrollbar.
Market and mobile Merchant use document scrolling for ordinary long pages.

The shared `site.css` clips overflow at `#root` without making it a scroll
container. Keep `overflow: clip` here: `overflow: hidden` would introduce a
different scroll owner and can break Market's sticky header and focus scrolling.
In-flow content still determines the root's height, so long document pages remain
reachable. Shared dropdowns and dialogs use body portals outside this boundary.

Both app main elements establish a positioning boundary. This matters even for
invisible controls: Radix Select renders an absolutely positioned native select
inside forms for form participation. Without a positioned scroll owner, that
control can be positioned against `#root`, escape an intervening overflow panel,
and enlarge the document far below the workspace. Ordinary tall content alone
does not reproduce this failure. Keep the native control and its form behavior.

When adding an independently scrolling panel, give positioned descendants a
containing block inside that panel. Keep intentional overlays in the shared
portaled primitives. The root clip is a final guard against escaped overflow,
not a replacement for correct inner-panel layout or reachable content.

`e2e/scroll-containment.playwright.ts` mounts real shared form controls in multiple
Merchant and Market routes. It covers long forms, focus scrolling, dropdown and
dialog portals, deliberately escaped root controls, and Merchant's desktop/mobile
scroll-owner transition. Browser evidence uses Linux and disposable identities;
it establishes layout behavior, not signer interoperability or relay delivery.

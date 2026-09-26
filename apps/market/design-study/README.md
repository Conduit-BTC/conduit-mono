# Market home design study — DO NOT MERGE

A live wireframe for experimenting with Market's home/products page. It starts
from Conduit's fonts, Day Market / Night Market themes, and accessible controls.
The page and product cards are intentionally local copies you can freely reshape.

Starter screenshots: [desktop / Night Market](screenshots/desktop-night.png),
[desktop / Day Market](screenshots/desktop-day.png),
[phone / Night Market](screenshots/phone-night.png), and
[phone / Day Market](screenshots/phone-day.png).

**This branch is a design exercise. Keep the PR as a draft. Do not merge or deploy
it as Market.** An approved design would be brought into production separately.

## Open your own sandbox

1. Fork the repository **including this branch**: `feat/market-home-design-study`.
   In GitHub's fork form, uncheck **Copy the main branch only**. If you already have
   a fork, fetch this branch into it before continuing.
2. Select `feat/market-home-design-study` in your fork.
3. Choose **Code → Codespaces → New with options**, verify the branch, and choose
   the **Market design study** configuration. Create the Codespace in your account.
4. Wait for dependency installation, then run this from the repository root:

   ```sh
   bun run dev:study
   ```

5. Open forwarded port **7000**. Leave its visibility private while working.

Codespaces can use your account's allowance or incur charges. Stop it when done.
These instructions do not deploy the study. Repository preview automation may
build the normal apps; those previews do not serve this standalone page.
Never add production secrets or connect a signer/wallet for this exercise.

For an ordinary local clone: install the repository's Bun toolchain, run
`bun install --frozen-lockfile`, then `bun run dev:study`. Use Node 22.12+ when
running the Vite CLI with Node. The devcontainer supplies Node 22 and Bun 1.3.5.

## Where to edit

| File in `src/`               | What it controls                                                  |
| ---------------------------- | ----------------------------------------------------------------- |
| `StudyPage.tsx`              | Page layout, category/filter toolbar, grid, empty/loading states  |
| `StudyHeader.tsx`            | Brand, search, theme switcher, pretend cart                       |
| `StudyProductCard.tsx`       | Card layout, option selector, sample product dialog               |
| `ProductArtwork.tsx`         | Placeholder artwork and missing-image appearance                  |
| `fixtures.ts`                | Fictional products, shops, categories, prices, options            |
| `study.css`                  | Study-only spacing, widths, surfaces, card shape, theme overrides |
| `assets/` (create as needed) | Local product photos or other visual assets                       |

Start with `StudyPage.tsx` and `study.css`. There is no requirement to preserve the
current layout. You can change typography, spacing, card structure, and how the
page groups information. Keep the sample-data notice and accessible controls.

Change the study CSS, not the production token files. The first few variables
expose the main layout controls; the comments show where Day/Night-specific
overrides go. This is not a new theme system or a commitment to new design tokens.

To use a photo, add a local file, import it in `fixtures.ts`, and set a product's
`image` to that import. The default vector artwork requires no remote assets.

## What works (and what is fake)

- Search, categories, shops, sorting, and option selection use 12 sample products.
- Add buttons update a **counter**, not a real shopping cart. The cart dialog can
  clear it. Product dialogs are placeholders; there is no checkout.
- **Study controls** below the grid lets you inspect loading and empty states.
- The appearance button uses the existing System → Day Market → Night Market
  cycle. Only the theme preference persists in localStorage on this preview's
  origin. Filters and cart count reset on reload.
- Long titles, sold-out items, options, and missing artwork are included.
- No authentication, product feeds, publishing, wallets, service workers, or
  telemetry are initialized. Market `.env` files are not loaded.

`index.html` and `src/main.tsx` are a separate entry point, not a production route.
The config imports only the shared theme bootstrap, React, and Tailwind. `ui.ts`
selects safe shared component files rather than the connected UI export barrel.
Normal Market builds and deployment previews do **not** include this study.

This isolates app behavior, not repository access: a branch/fork still contains
the repository. The local-only page policy and tests are guardrails, not a
security sandbox for arbitrary code added later.

## Check and share

From the repository root:

```sh
bun run typecheck:study
bun run build:study
bunx eslint apps/market/design-study
bun run test:study
```

Browser tests require Playwright Chromium (`bunx playwright install chromium`).
They start only the study on port **7070**, exercise local interactions, check
mobile/desktop layouts and both themes, and reject off-origin requests. They also
check the built page on port **7071**. They do not prove production commerce works.

Capture desktop and phone views in both themes. Share your branch and screenshots,
plus a few sentences about your choices. A Codespaces preview link only works
while the Codespace is running and the viewer has access. Keep the design PR
**draft / DO NOT MERGE**. Review and production implementation are separate steps.

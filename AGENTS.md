# AGENTS.md — Project Knowledge Base

## OVERVIEW

Pure front-end IPFS image gallery (React 19 + TypeScript + Vite 8 + MUI 9). Media is retrieved
and hash-verified inside a module Web Worker (`src/worker/`), exposed to the app only as
verified Blob URLs. Reader (single media, focus) and Album (shortest-column masonry) modes
share one filtered item list; tools live in a MUI temporary left sidebar.

## STRUCTURE

```
src/
├── core/        # query parsing, manifest (JSON/YAML/TOML), media type detection — pure logic
├── network/     # trustless gateway broker, block verification, path safety, cache
├── worker/      # gallery.worker (main-thread client via protocol.ts); ALL byte verification here
├── shared/      # contracts.ts (public types), errors, gateways, limits — no UI imports
├── hooks/       # assetService (128 MiB pool, 3 slots, ref-leases), useGallery, useReaderAsset
├── app/         # App.tsx sole orchestrator (mode/panel/focus); format.ts, readerAlbumTypes.ts
├── components/  # ReaderSurface, AlbumGrid/Tile, GalleryDrawer/Panels/Chrome, SourceForm…
└── theme/       # tokens.css (single source of visual truth) + MUI theme mapping tokens
tests/
├── fixtures/    # unixfs importer builds real CID fixtures incl. tiny.webm
├── support/     # trustless-gateway dev server, owned-audit-browser launcher
├── audit/       # Lighthouse via playwright-lighthouse on run-owned Chromium CDP endpoint
├── e2e/         # Playwright specs (fixtures auto-block external requests)
└── ui/ core/ network/ worker/ shared/  # Vitest unit tests (mirrors src)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| URL/query semantics | `src/core/query.ts` | `unixfs`/`cid`/`meta` sources + `q/tag/type/item/gateway` view params; no `mode` in URL |
| Asset pooling/cancellation | `src/hooks/assetService.ts` | priority 0 original / 1 thumbnail / 2 fallback; LIMIT/CANCELLED never escalate |
| Reader gestures/zoom | `src/hooks/readerInteraction.ts` | thresholds shared by E2E; IME/multi-touch guards |
| Masonry geometry | `src/hooks/masonryLayout.ts` | tokens `--album-column-*-min` read from computed CSS, not window width |
| Sidebar panels | `src/components/GalleryDrawer.tsx` + `GalleryPanels.tsx` | keepMounted; drafts survive close; tool portals render into dialog |
| Audit harness | `tests/audit/audit-route.ts` | 45s work + bounded dispose/close/settle per run; document-bound React evidence before BFCache |

## CONVENTIONS

- Chinese-first UI copy; every control has a Chinese accessible name.
- All colors/spacing/type trace to `src/theme/tokens.css` + `DESIGN.md`; no raw hex in components.
- CSS files are namespaced per surface (`reader.css`, `album.css`, `app.css`); entry CSS is inlined by Vite.
- Commands run in PowerShell; no `&&` chaining.
- Tests never rely on network beyond `tests/support/trustless-gateway.ts` fixtures; E2E blocks all
  external requests unless the spec opts in (public smoke uses real default gateways).

## ANTI-PATTERNS (THIS PROJECT)

- Do not edit `src/core/`, `src/network/`, `src/worker/`, `src/shared/` for UI needs — app adapts to them.
- Do not persist UI state (mode, chrome, panel, scroll, CID history) to storage; preferences v1 has a
  strict field whitelist (`tests/ui/preferences.test.ts` enforces reject-on-unknown).
- Do not render media from unverified gateway URLs; the worker is the only byte path.
- Do not cover native `<video>` controls with capture layers; reader tools avoid the control area.
- Do not weaken assertions (44px targets, 2px anchor tolerance, exact verified bytes) to make suites pass.
- Never build to default `dist/` for verification — use `pnpm run build:reader-album` (`.reader-album-build/`).

## COMMANDS

```powershell
pnpm typecheck; pnpm typecheck:shared; pnpm lint; pnpm test   # statics + 330 unit tests
pnpm run build:reader-album                                    # isolated prod build (never default build)
pnpm exec playwright test --config playwright.config.ts --retries=0   # full E2E (2 workers, 4183 preview)
pnpm run test:deployment   # /gallery/ subpath + CSP
pnpm run test:smoke        # real public gateway (network-dependent, report separately)
pnpm run audit:browser -- --retries=0   # 6 surfaces × 3 runs Lighthouse, 1 worker
pnpm run doctor:react      # react-doctor static scan (20 known warnings, see NOTES)
```

## NOTES — DEBUGGING EXPERIENCE

- **Playwright config pitfalls**: CI sets `retries: 2` — always pass `--retries=0` explicitly for
  acceptance runs; `pnpm run test:e2e -- --retries=0` silently forwards `--` to Playwright (args land
  as positional), use `pnpm exec playwright test … --retries=0` instead.
- **Port 4183 is the E2E/audit preview** (`preview:reader-album`, strictPort, `reuseExistingServer:
  false`); 4173 belongs to the user's live preview — never touch it, its processes, or `dist/`.
- **Flaky timeouts**: historic 22/24-readiness and endpoint-launch 90s timeouts were observed under
  parallel browser load and never root-caused. Do not mask with retries/longer timeouts; rerun the
  same case in isolation and keep failure evidence.
- **Lighthouse `LanternError: NO_LCP` on stderr** during empty-page audits is secondary BFCache-probe
  noise: verify `lhr.runtimeError === null` and that `largest-contentful-paint` has numericValue/score
  in each run JSON before trusting category scores.
- **BFCache probe breaks transient state**: Lighthouse 13.5 navigates to `chrome://terms` and back at
  the end of gathering, reloading the app. Target-state verification (geometry/PNG/React events) must
  happen in `before-bfcache` checkpoint against the measured document, or album state "resets" to reader.
- **React portals bypass MUI fiber handlers**: keydown logic attached via JSX on the dialog root never
  sees portal children; use a native DOM listener on the actual dialog element (guards: IME 229,
  defaultPrevented, single-Escape). Focus-trap must stay enabled; same-position toggles live inside
  the trap scope.
- **CSS zoom units**: `getBoundingClientRect()` returns visual (zoomed) px while layout APIs
  (`clientWidth`, computed widths) are unzoomed — mixing them causes mis-hit tests at 150–200% zoom.
  `parseFloat('.18s')` is 0.18 *ms* — parse CSS durations with unit awareness (see `usePanelDuration`).
- **Windows font reality**: first CJK layout pays ~130ms `FontCache::GetFontPlatformData` per Noto
  face (25/17 MB mapped locals). Font-family reuse tricks measured no net win; keep fonts as-is and
  avoid synchronous geometry reads on startup hot paths instead.
- **react-doctor baseline**: 20 warnings (6 complexity, AlbumTile effect-pairs, index keys in static
  text lists, one non-interactive handler with named keyboard path) — reviewed as acceptable; do not
  churn code just to zero them.
- **StrictMode double-mount** fires dev-only double requests; production sources tests are the
  authority for request counts, not dev-server observation.

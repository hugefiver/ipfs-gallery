# Project maintenance guide

## Scope and entry points

IPFS Gallery is a browser-only React/TypeScript application. The module Worker retrieves and hash-verifies content; the main thread creates Blob URLs from verified bytes. Reader and Album share the filtered list and one asset pool. Use [README](README.md) for usage, deployment, privacy and limits, [DESIGN](DESIGN.md) for interface requirements, and [fixture documentation](tests/fixtures/README.md) for deterministic browser data.

| Area | Responsibility |
| --- | --- |
| `src/core/` | Query normalization, JSON/YAML/TOML manifests, paths, discovery and media validation |
| `src/network/` | HTTPS raw-block broker, multihash verification, cache and UnixFS exporter adapter |
| `src/worker/` | Worker runtime, typed client and message validation |
| `src/shared/` | Contracts, errors, gateways and resource limits, without UI imports |
| `src/hooks/` | Gallery sessions, preferences, asset scheduling, leases and reader interaction |
| `src/app/` | App orchestration, selection, mode, panels and focus |
| `src/components/` | Reader, Album, Drawer, panel contents and native input surfaces |
| `src/theme/` | Visual tokens and MUI mapping |
| `tests/` | Unit tests, deterministic UnixFS fixtures, E2E, deployment, public smoke and audit suites |

Adapt UI to the data contracts rather than changing core/network/Worker protocols for layout needs. Preserve existing user changes. Run shell commands in PowerShell. Don't install software or perform Git writes without authorization for that operation.

## Data and lifecycle contracts

All content blocks pass multihash validation before the UnixFS exporter consumes them. Don't yield unverified network chunks, use remote media URLs as fallback, hand-write a replacement DAG/HAMT decoder, or add undisclosed network channels. The broker uses only configured HTTPS gateways; requests omit credentials and referrers and reject redirects. Cache only verified blocks. Cancellation by one consumer must not abort another consumer's shared block request; abort fetch when its final consumer releases it.

Worker messages are validated at runtime. Every request has exactly one terminal result/error; progress and telemetry aren't completion. Cancellation ends an unfinished target with CANCELLED and separately acknowledges the cancel request. Completed targets are idempotent no-ops. New discovery invalidates the prior session. Reject stale session/request results before creating Blob URLs; crashes settle pending promises and permit recovery. Transfer exact-length, exclusively owned asset buffers, never a shared cache buffer.

Keep separate bounds for verified block cache, assembly reservation, unconsumed results and Blob cache. The shared limits remain authoritative, including 128 MiB Blob cache and three outstanding asset slots across sessions. Cancellation doesn't free a real in-flight slot before terminal settlement. Cache hits count toward operation input budgets. Reserve assembly peak space, consume or discard bounded results before scheduling more, and report LIMIT rather than adding an unbounded queue. These aren't total browser-memory guarantees.

`AssetService` and `MainAssetSet` provide one resource pool. Originals and explicit downloads use priority 0, visible thumbnails 1, verified original fallback 2. LIMIT/CANCELLED don't trigger a more expensive fallback. Acquire only visible album assets, release mode-only consumers on exit, and don't clear the shared session/cache for mode or panel changes. Share one IntersectionObserver per album scroll root; don't create one per tile. Cache gesture geometry at pointer-down instead of synchronously measuring every pan/pinch frame.

The reader owns decode, transform, gestures and download scope; App owns mode, panel and focus intentions. Panel visibility must not become the reader asset's enabled condition. Tool portals exist only in the active host; inert exit paint cannot retain an action/resource owner. Downloads acquire a separate verified-original lease and allow a one-second handoff before release. Same-item downloads may survive panel closure; item/session/mode changes cancel old work. Sanitize filenames and release Blob references without revoking a still-used viewer/download resource.

## Query, discovery and preferences

Sources use the shared normalizer and canonical serializer. Keep precedence, one-pass decoding, path safety and size budgets from README. Views and selections use replace semantics, source navigation uses push, and popstate restores URL state. An unknown or filtered-out item never expands the filter or silently opens an unrelated media item. Mode, chrome and panel state don't enter URLs or history.

For explicit manifests, known extensions select their parser; otherwise JSON, TOML and YAML are tried within the same budget and must pass the full schema. Directory discovery uses the first existing authoritative manifest and requires explicit browse to bypass a bad one. Scanning doesn't follow symlinks or interpret nested manifests; preserve valid duplicate paths rather than globally deduplicating every CID. Metadata dimensions are hints, not verified original dimensions. All metadata stays plain text.

The only preference key is `ipfs-gallery.preferences.v1`. Preserve the strict version/field whitelist and compatibility layout/sidebar fields without restoring their old UI behavior. Limit the stored JSON to 40 KiB before parsing; gateways are normalized through the shared normalizer, with at most eight entries and 4096 characters per input. Reject unknown fields, polluted keys and invalid records as a whole. An empty gateway preference means defaults.

Default to no writes. A valid saved record restores opt-in; explicit enable saves the current local preference snapshot, not a URL override. URL gateways take priority over local preference and defaults, but don't become local preference until explicit apply. Invalid URL configuration fails closed. Storage getter/read/write/remove failures leave memory usable and report the actual outcome. Disabling save deletes only this key and stops writes, even if deletion fails; clear-and-reset also restores defaults without overriding explicit URL gateways. Never call localStorage.clear(), persist CID/path/item/filter/media/history/authentication/statistics, or add cross-tab synchronization. Gateway cancel drops only unapplied edits; a storage failure isn't rejection of a valid in-memory gateway setting.

## Interface and verification

Keep Chinese accessible names, native video controls, IME guards and browser zoom. Respect the actual portal DOM keyboard boundary and MUI focus trap; a React ancestor handler needn't receive a portal's key event. Apply explicit source/navigation focus intentions before ordinary close restoration. Don't let late resource completion steal focus.

Use isolated production output for verification; ordinary release/deployment builds may use `pnpm build` as documented in README. Don't replace a user's `dist/`, take over port 4173, reuse a personal browser profile or terminate processes by port/name. Test services use 4183 with exclusive ownership; suites sharing it and report directories run serially. Cleanup is limited to owned resources; process termination requires PID and start identity.

Run checks relevant to changes locally, then consolidate affected integration checks. Don't freeze prose, package descriptions or deleted-component absence with tests. Preserve functional protocol, safety, cancellation, resource and real download-byte assertions. Don't weaken a failing check, mask it with retries or call an interrupted run a pass.

```powershell
pnpm typecheck
pnpm typecheck:shared
pnpm lint
pnpm test
pnpm build:reader-album
pnpm exec playwright test --config playwright.config.ts --retries=0
pnpm exec playwright test --config playwright.deployment.config.ts --retries=0
pnpm exec playwright test --config playwright.smoke.config.ts --retries=0
pnpm exec playwright test --config playwright.audit.config.ts --retries=0
pnpm audit:support
pnpm doctor:react
```

Fixture tests exercise real Worker/raw-block/UnixFS verification and deny unexpected external requests. Public smoke deliberately uses real gateways and is reported separately. Compare actual downloaded and rendered bytes, not success text. Production builds must not load development-only tools or test gateway defaults. Deployment checks cover `/gallery/`, module Worker paths, Blob media and the documented CSP; don't weaken CSP to fix layout.

Audit the measured document's target state before BFCache probing, which may reload transient album state. Check runtimeError and numeric LCP evidence, not just category scores. Use run-owned Chromium/CDP through Playwright, not Lighthouse CLI. Empty/reader/album each have mobile and desktop samples, three per group; report medians and retain real failures. Support-suite success doesn't establish UI audit scores. CSS zoom changes visual geometry units; don't mix getBoundingClientRect() coordinates with unscaled layout measurements. Production request counts, not DEV StrictMode double-mount observations, determine duplicate-load behavior.

The ordinary no-source entry is closed and opened explicitly. Tests must exercise the same product experience, not a webdriver/port-specific substitute. Report unverified screen-reader, browser-engine, deployment-header and public-network coverage rather than inferring it from compilation or fixture success.

# UnixFS browser fixtures

`createGalleryFixtures()` in `unixfs.ts` uses the standard UnixFS importer and blockstore-core. It returns:

- `store` and `blocks`: a generator-read memory blockstore and a complete original-codec CID → bytes index. Every block is independently SHA-256 checked; DAG-PB links must resolve inside the index.
- `raw`, `dagPb`, `multiblock`, `video`: real, decodable media with exact `bytes`, canonical file `cid`, and `ref`.
- `directories.json/yaml/toml`: equivalent version-1 metadata with relative Chinese filenames and nested extensionless media.
- `directories.nested/hamt/invalid`: recursive media, a standard HAMT forced by a 64-byte shard threshold, and an invalid authoritative JSON file with a later YAML candidate.
- `manifests`: addressable JSON/YAML/TOML, extensionless parent-relative metadata, standalone raw-CID metadata using explicit item CIDs, and invalid metadata.
- `expected`: manifest titles, tags, and HAMT filenames. `contentUri(ref)` serializes shareable IPFS references.

PNG pixels are generated deterministically in `media.ts`, with RGB scanlines, real zlib compression, and valid CRCs. No SVG or arbitrary fake image bodies are used. `tiny.webm` is a self-generated 1-second, 32×24, four-frame, silent VP8 clip. It is checked into the fixture set; FFmpeg is not required to run tests. If regeneration is needed, run an already-installed FFmpeg from this directory with a new output filename:

```powershell
ffmpeg -hide_banner -loglevel error -f lavfi -i "color=c=0x5c633f:s=32x24:r=4:d=1" -an -c:v libvpx -b:v 20k -map_metadata -1 -fflags +bitexact -flags:v +bitexact "tiny-regenerated.webm"
```

`startTrustlessGateway(blocks, mode?)` in `../support/trustless-gateway.ts` binds an assigned loopback port, serves only individual `format=raw` blocks with the proper `Accept` header, records request headers/status/abort/count/concurrency, and supports correct, corrupt, 404, 429, and delayed responses. `setBlockMode` overrides one CID. Call `close()` in `finally`.

Application E2E uses the real Service Worker and a fail-closed proxy from `../support/sw-allowlist-proxy.ts`. Explicit public-format router, provider and gateway authorities map to test-owned loopback listeners; unknown destinations are rejected without external DNS or connections. `sw-https-fixtures.ts` provides bounded delegated-routing and raw-block HTTPS responses. `ipfs-provider.ts` uses the official Helia/libp2p stack to serve real Noise/Yamux/Bitswap over WSS, with observable wants, cancellation and bytes. Neither Worker RPC nor gallery/asset results are mocked.

Use the test certificate and its exact Chromium SPKI trust argument from `sw-test-tls.ts` and `sw-tls.ts`; do not disable certificate checks globally or change the system trust store. Close every owned service in `finally`. Production provider/gateway validation remains enabled: local listeners are reachable only through the test proxy's explicit mappings, not through a hostname, port or webdriver bypass in product code.

The direct retrieval case denies gateway access and compares rendered/downloaded bytes with the original fixture. HTTPS-provider and gateway-fallback cases are separate: their success does not prove Bitswap retrieval. Cancellation evidence must come from the application's operation and the provider's received protocol messages, not a manually injected cancel frame. A successful same-origin ticket fetch establishes SW admission, not the provenance of arbitrary HTTP body bytes; admitted bytes travel through the binding's private one-shot response and fixed Worker relay.

Build-policy coverage uses separately compiled strict and trusted-gateway variants, never a runtime mode override. Strict builds reject wrong-hash gateway blocks; trusted-gateway builds may admit those blocks only from the configured gateway branch. Dynamic HTTP providers and Bitswap remain strict in both variants, including a provider sharing a gateway hostname. Compare actual media and download bytes, verify that digest-exempt results do not populate the verified cache, and reject mismatched realm policies. Source mutation after SW admission must not change the owned snapshot delivered later.

Run infrastructure checks without an app build:

```powershell
pnpm exec vitest run tests/fixtures
```

The fixture browser check uses a newly owned Chromium browser and empty context to decode PNG/WebM media without content-network requests. It does not exercise the application transport; application E2E provides that coverage. An installed Playwright Chromium is required; tests do not install it.

Run app E2E against the isolated production build, without replacing `dist/` or using the regular preview on port 4173:

```powershell
pnpm build:reader-album
pnpm exec playwright test --config playwright.config.ts --retries=0
```

The E2E preview uses port 4183. Let the suite start its own server; don't run suites sharing that port concurrently. `sourceUrl(source, refs, view?, gateways?)` builds shared source/query links. Accessibility queries live in `../e2e/gallery-ui.ts`. Responsive tests attach real screenshots rather than locking screenshots as descriptive snapshots.

# UnixFS browser fixtures

`createGalleryFixtures()` in `unixfs.ts` uses the standard UnixFS importer 17 and blockstore-core 7. It returns:

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

Playwright's `../e2e/gateway-route.ts` maps only `https://slow.gallery-fixture.net/ipfs/**` and its fast equivalent to those owned HTTP servers using Node fetch. These syntactically public HTTPS gateway URLs are checked by the production gateway normalizer. The bridge fulfills the exact server status, headers, and bytes. Neither Worker RPC nor gallery/asset results are mocked. Unexpected external requests are aborted in both the browser probe and app E2E fixtures; fixture-domain requests never reach the actual network.

Run infrastructure checks without an app build:

```powershell
pnpm exec vitest run tests/fixtures
```

The browser check uses a newly owned Chromium browser and empty context to decode all media and prove dedicated Worker HTTPS requests are intercepted by `context.route`. An installed Playwright Chromium is required; the test does not install it.

Run app E2E after a successful production build using the unchanged project Playwright configuration:

```powershell
pnpm build
pnpm test:e2e
```

`sourceUrl(source, refs, view?, gateways?)` builds shared source/query links. Accessibility queries live in `../e2e/gallery-ui.ts`. Responsive tests attach real screenshots at 375, 768, and 1280 pixels rather than locking screenshots as descriptive snapshots.

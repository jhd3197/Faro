# Screenshots — how they're made

The PNGs in this folder are **auto-generated** from a mock-data demo build, so
every hostname, IP, username, path, and metric is fictional. They render in the
README's **Screenshots** section (between the `<!-- FARO:SHOTS:START -->` and
`<!-- FARO:SHOTS:END -->` markers).

## Regenerate them

```bash
npm run shots
```

That script (`scripts/capture-screenshots.mjs`):

1. starts the **mock Vite build** (`npm run dev:mock`, i.e. `vite --mode mock`),
   which swaps the Tauri `invoke`/`listen`/`path`/`window` modules for the
   in-browser mocks in `src/mock/` — the whole UI renders with fake data and **no
   Rust backend**;
2. drives the UI with headless Chrome/Edge (via `puppeteer-core`, using an
   already-installed browser — no download) into each state and writes the PNGs
   here.

No real servers, credentials, or network are involved.

## What gets captured

| File | Screen |
|---|---|
| `overview.png` | Dual-pane browser (local + remote) |
| `server-rail.png` | Expanded labeled connection rail |
| `terminal.png` | Integrated SSH terminal |
| `context-menu.png` | File-row actions (duplicate / properties / download-as / open-terminal-here) |
| `transfers.png` | Transfers panel (progress + queued/done) |
| `sync.png` | Directory-sync plan |
| `agent-bridge.png` | Agent Bridge panel |
| `new-connection.png` | Profile editor (two-pane, grouped protocol rail) |
| `settings.png` | Settings |
| `disk-usage.png` | Disk Usage explorer — treemap + size-ranked list |
| `object-storage.png` | S3 bucket browsing |

## Tweaking the shots

- **Change the demo data** (servers, file listings, transfers, bridge state,
  terminal transcript): edit `src/mock/data.ts`.
- **Add / reorder shots or change what each captures**: edit
  `scripts/capture-screenshots.mjs`. It drives the app through the store handles
  exposed on `window.__demo` (see `src/mock/demo.ts`).
- **Preview the demo build by hand**: `npm run dev:mock`, then open
  http://localhost:1425.

If you add a shot, also add its `docs/screenshots/<name>.png` reference inside
the `FARO:SHOTS` block in `README.md`.

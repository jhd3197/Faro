# Development

```
┌──────────────────────────────────────────────────────────────┐
│  React + TypeScript + Tauri webview                          │
│  Dual-pane browser · xterm.js terminal · sync / diff /       │
│  disk-usage / search / skills panels · Agent Bridge          │
└──────────────────────────┬───────────────────────────────────┘
                           │  Tauri commands + events
┌──────────────────────────┴───────────────────────────────────┐
│  Rust core (faro_lib)                                        │
│   RemoteFs → Local·Sftp·Ftp·Object(S3/Azure/GCS)·WebDav·     │
│              Http·Dropbox·OneDrive·GDrive·Box·Agent           │
│   SessionManager pools one session per profile               │
│   TransferManager → concurrent file + directory transfers    │
│   scan.rs (bounded walk + fast paths) → diskscan · diff ·    │
│              search · sync::plan   ·   faro.db (SQLite)       │
│   foldersync.rs → continuous watched sync pairs              │
│   bridge.rs → localhost MCP/HTTP + approvals + Skills        │
│   oauth.rs · importers/ · known_hosts + HostKeyVerifier      │
└───────────────┬───────────────────────────┬──────────────────┘
                │  same Rust core            │  Noise protocol
┌───────────────┴──────────────┐  ┌──────────┴──────────────────┐
│  faro-cli  (clap)            │  │  faro-agentd (controlled     │
│  ls·cp·mv·rm·sync·diff·      │  │  machine): handshake · pin · │
│  search·exec·agent·skill     │  │  policy · native exec + fs   │
└──────────────────────────────┘  └─────────────────────────────┘
```

The file tools share one `RemoteFs` trait. Adding a new backend means writing one trait impl and one builder; the dual-pane browser, the sync planner, the disk-usage / diff / search tools, the CLI, and the transfer engine all pick it up automatically.

## Build the desktop app

Run these commands from the repository root. Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system first.

```bash
npm install
npm run tauri dev
```

The first build compiles the Rust dependencies. Build time depends on your machine and cache.

**Prerequisites**: Node 20+, Rust 1.88+ (`rustc --version` — Tauri 2's transitive deps require it).

## CLI

A standalone binary, `faro-cli` — its own workspace crate under `src-tauri/faro-cli/` — reuses your saved GUI profiles. Prebuilt binaries ship with every [release](https://github.com/jhd3197/faro/releases/latest), or build it yourself:

```bash
cd src-tauri
cargo build -p faro-cli --release
# → target/release/faro-cli

# File ops — any backend, using your saved profiles
faro-cli profiles list
faro-cli ls prod:/var/log
faro-cli cp ./report.pdf prod:/var/www/uploads
faro-cli sync ./site prod:/var/www/site --mirror --dry-run
faro-cli rm prod:/tmp/build --recursive

# Compare and search — remote↔remote works too
faro-cli diff prod:/etc staging:/etc --hash
faro-cli search prod:/var/log "OutOfMemory" --content --regex
faro-cli exec prod 'systemctl status api'      # SSH profile shell

# Drive the app's Agent Bridge (goes through Faro's approval + console)
faro-cli agent exec prod 'journalctl -u api -n 100'
faro-cli agent exec prod --detach 'apt-get -y upgrade'   # background job id
faro-cli agent write prod /etc/app/patch.conf --from-file ./patch.conf
faro-cli skill run deploy --target all --param branch=main --dry-run

# Fetch an auth-walled page with a saved HTTP(S) profile's creds
faro-cli fetch https://staging.example.com/admin

faro-cli self-update --check   # the CLI ships separately and can lag the app
```

The CLI mirrors the GUI: `ls · cp · mv · rm · mkdir · sync · diff · search ·
exec · profiles`, plus `agent` (drive the running Agent Bridge — `exec`,
`script`, `write`, `read`, background `job`/`jobs`, `search`, `download`,
`upload`), `skill`, `fetch`, and `self-update`. Path syntax: bare paths are
local (including Windows `C:\…`), `name:/path` references a saved profile — so
`diff`/`sync` can span two remotes. It prompts on stdin for unknown host keys
and never writes secrets to disk that the GUI hadn't already saved.

## Layout

```
src/                       React frontend
  components/              DualPaneBrowser, FileBrowser, Terminal,
                           SyncDialog/SyncSettings, DiskUsage/DiskTreemap,
                           DirectoryDiff, FleetSearch, SkillsPanel, AgentBridge,
                           ProfileEditor, ImportDialog, HostKeyModal, …
  stores/                  Zustand stores (bridge, sync, connections, …)
  lib/ipc.ts               Typed wrappers around Tauri commands
  lib/types.ts             Shared types (mirror Rust serde structs)
  mock/                    VITE_MOCK demo data + invoke/listen fakes (screenshots)

src-tauri/src/
  commands.rs              Tauri command surface
  bridge.rs                Agent Bridge — localhost MCP/HTTP server, per-command
                           approval, audit log, Fleet Skills store + runner
  remotefs/                RemoteFs trait + Local/Sftp/Ftp/Object/WebDav/Http/
                           Dropbox/OneDrive/GDrive/Box/Agent impls
  session/                 One session type per backend, SessionManager,
                           HostKeyVerifier trait
  oauth.rs                 Loopback + PKCE OAuth (Dropbox/OneDrive/Drive/Box)
  scan.rs                  Bounded-concurrency RemoteFs walk + strategy select
  db.rs                    faro.db (bundled SQLite) — scan/sync state index
  diskscan.rs / diff.rs / search.rs   scan-engine consumers
  foldersync.rs            Continuous watched sync pairs (watcher + reconciler)
  sync.rs                  Two-tree one-shot sync planner
  transfer/                Per-backend streaming transfers + progress
  terminal.rs              PTY over russh, emits events
  agent.rs / agent_host.rs Faro Agent client + in-app "Remote control" host
  cli_updater.rs           faro-cli version-drift check + self-update
  editor.rs · deeplink.rs · importers/ · known_hosts.rs · virtualfs/

src-tauri/faro-cli/        Standalone CLI crate — path-depends on faro_lib
  src/main.rs              clap + indicatif: ls·cp·mv·rm·mkdir·sync·diff·search·
                           exec·agent·skill·fetch·self-update

src-tauri/faro-agent-proto/  Faro Agent wire protocol (Noise channel, msg set,
                             identity/pairing) — Tauri-free, shared by both ends
src-tauri/faro-agentd/       Headless daemon run on a controlled machine:
  src/{server,ops,config,discovery}.rs  handshake·pin·policy·native exec+fs·mDNS
```

## Windows PATH gotcha

If you installed Rust via Chocolatey (`choco install rust`), there's a `rustc.exe` at `C:\ProgramData\chocolatey\bin` that **shadows** the rustup-managed toolchain. `rustup update stable` updates the rustup copy but doesn't touch the chocolatey one, so `rustc --version` keeps reporting the old version and Tauri builds fail with messages like `rustc 1.85.0 is not supported by darling@0.23.0`.

```powershell
# Option A — uninstall the chocolatey copy (recommended)
choco uninstall rust

# Option B — keep both, but make rustup win for this shell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
```


## App icons

Replace `src-tauri/icons/source.png` with a 1024 × 1024 PNG, then run from the repository root:

```bash
npm run tauri icon src-tauri/icons/source.png
```

`scripts/process-icon.py` crops a black-bordered source PNG to its rounded-square artwork and writes `source.png` at the expected size.

## README artwork

Run `node scripts/generate-readme-art.mjs` from the repository root to regenerate the SVG banner and cards in `docs/images/readme/`. The script owns the charcoal and gold palette, text, and layouts. Use the existing lighthouse icon for the app identity.

The transfer cards describe implementation behavior, not measured throughput. Update them when the corresponding limits in `src-tauri/src/transfer/sources.rs` change. Comparative speed claims need a reproducible workload, client versions, server and network details, repeated timings, and integrity checks.

For app screenshots, see [the capture guide](screenshots/CAPTURE.md).

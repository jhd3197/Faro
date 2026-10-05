# Faro Roadmap

How the individual plans sequence, and where Faro sits in the wider
DeviceKit / ServerKit ecosystem. Each plan doc has the detail; this is the map
and the order.

## The ecosystem in one picture

Faro is the **client/hub**: a desktop app for reaching files and machines
(SFTP, FTP, S3, and Faro's own Noise-paired **agent**). Two sibling "kits"
manage fleets and hand off to Faro:

- **DeviceKit** — Android device fleet (Flask + React + Kotlin agent + extensions).
  **Connects to Faro at the agent-protocol level**: the Android agent embeds
  Faro's `faro-agentd`, so a phone appears in Faro as a first-class connection
  (browse/transfer/sync). *Done — shipped.*
- **ServerKit** — server control panel, the server-fleet analog (Flask + React +
  **Go** host agent + extensions). **Connects to Faro only via a `faro://`
  deep-link** today (`serverkit-faro` prefills Faro's New Connection with a
  site's SFTP details). It does **not** use Faro's agent protocol. *Shallow link
  only — see Track D.*
- Shared libraries: **Prompture** (multi-LLM) and **Tukuy** underpin the AI
  features across CachiBot / DeviceKit / ServerKit.

So Faro has two integration depths: a **deep** one (embed `faro-agentd` → the
machine is controllable/browsable in Faro; DeviceKit does this) and a **shallow**
one (`faro://` deep-link prefill; ServerKit does this).

---

## Plan build order (the file numbers ARE the order)

Read this instead of the roadmap if you just want "what's next." The plan files
are numbered in the order to build them; the Track sections below are the
thematic detail.

| # | Plan file | Status | Why here |
|---|-----------|--------|----------|
| 1 | `1_faro-agent-pairing-and-distribution` | ✅ shipped | The agent — foundation everything else leans on. |
| 2 | `2_continuous-folder-sync` | 🔄 Phases 1–2 + safety merged; runtime test left | The shipped sync engine. |
| 3 | `3_scan-index-foundation` | ✅ built (runtime test on a live backend left) | Shared scan engine + `faro.db`. Substrate for 4/6/7 and the sync state index. |
| 4 | `4_disk-usage-explorer` | ✅ built (GUI click-through on a live backend left) | First *visible*, read-only consumer of #3 — proves the foundation at low risk. |
| 5 | `5_additional-backends` | 🔄 Phases 0–2, 4, 5 shipped (S3/GCS/WebDAV/HTTP + all 4 OAuth clouds) | Only SMB (Phase 3) remains — blocked on MSVC/libsmbclient. |
| 6 | `6_directory-diff` | ✅ built (CLI runtime-verified local↔local incl. `--hash`/`--json`; live-backend + GUI click-through left) | Reuses #3's scan engine (two trees) + `change_signal`/`etag`. |
| 7 | `7_fleet-search` | ✅ built (live-backend GUI click-through left) | Reuses #3's scan engine; later a `faro.db` filename index. |
| 8 | `8_fleet-skills` | ✅ built (live multi-server fan-out run left) | AI-authored fleet automations over the bridge. Independent. |
| 9 | `9_on-demand-virtual-folders` | 🔄 Windows provider built (feature-flagged); Explorer verify left | OneDrive-style placeholders (Plan 2 Phase 3). Large, per-OS, Windows-first. |
| 10 | `10_faro-cli-agent-dx` | ✅ built (live SSH-box + phone-agent smoke tests left) | faro-cli/Agent-Bridge remote exec/write DX. All six phases in: CLI version-drift + self-update, `agent script`/`--stdin`, `agent write`, MSYS path guard, background/detached jobs (SSH + agent arms), authenticated `fetch`. Independent of the scan foundation. |
| 11 | `11_terminal-depth-and-snippets` | 🔄 Phases 1, 2, 4 built + runtime-verified (headless mock harness); Phase 3 (agent PTY) deferred — needs a paired phone | Terminal as a first-class surface: instance registry, split panes on one connection, snippets. Biggest everyday-UX win. |
| 12 | `12_security-settings-and-portability` | ✅ built (all 4 phases, runtime-verified) | Keychain-everything (fix the localStorage API key), settings in `faro.db` + pre-paint injection, structured errors, encrypted backup. Trust fundamentals. |
| 13 | `13_remote-previews-and-protocol-depth` | 🔄 Phase 1 shipped + verified; Phase 3 protocol foundation landed | Lazy remote image previews (viewport-budgeted) done. Native drag-out, SCP browse/UI, port forwarding, Docker SSH E2E fixtures remain. |
| 14 | `14_iconify-brand-icons` | ✅ Phases 1–3 shipped + runtime-verified (Phase 4 consolidation deferred) | Additive brand/protocol logos, bundled offline. |
| 15 | `15_keyboard-shortcuts` | ⬜ | Remappable shortcuts + Settings Keyboard tab + file-browser keys (F2 rename & friends). Builds on the Plan 12 settings substrate. Independent polish; do whenever. |
| 16 | `16_app-updater-and-notifications` | ⬜ | In-app auto-updater (signed, GitHub Releases manifest) + desktop notifications + one-click per-user PATH install. Trust/UX fundamentals for a shipping app. |
| 17 | `17_transfer-queue-depth` | ✅ built (all 4 phases; live-backend smoke run left) | Real queue (bounded concurrency), pause/resume, retry, bandwidth throttle. Turns the transfer list into an actual queue. |
| 18 | `18_jump-hosts-proxyjump` | ⬜ | Jump hosts (ProxyJump) through the single `ssh_connect` choke point + optional cloudflared integration. Unlocks locked-down (IP-allowlisted / tunnel-fronted) servers. Consumes Plan 13's bastion E2E fixture. |
| 20 | `20_hubspot-backend` | ✅ shipped (Phases 1–3, mock-verified; HubDB write-back future) | HubSpot portal as a connection, one private-app token over three surfaces: Design Manager as a real remote filesystem (Source Code API v3, draft/published roots), File Manager (Files API v3), HubDB tables as virtual CSV files (read-only). The Shopify recipe (`18_shopify-backend.md`, shipped), an even better fit. |
| 21 | `21_dynamics-365-backend` | 🔄 Phase 1 shipped + mock-verified (client-credentials only; delegated OAuth + Phases 2–3 planned) | Dynamics 365/Dataverse environment as a connection: web resources are literally files in a table (`webresourceset` OData — path-like names, base64 content, publish-to-deploy). Client-credentials or delegated Entra auth (reuses `oauth.rs`). Phase 2: tables as virtual CSV + `faro-cli dynamics query` (the wp-cli-style db helper). The XrmToolBox gap-filler. |
| 22 | `22_find-duplicates-dedupe` | ✅ built (unit-tested + CLI runtime-verified locally; live-backend + GUI click-through left) | Find & clean duplicate files — the `name_1.ext` copies rename-on-conflict leaves behind (name mode) or exact content duplicates (hash mode). GUI panel + `faro-cli dedupe` + `faro_dedupe` MCP tool. |
| 23 | `23_delta-sync` | ✅ Phases 1–3 built + unit-tested (Phase 4 panel indicator open) | Block-level differential transfer on the Faro Agent backend (FastCDC + BLAKE3): re-transferring a changed file ≥ 8 MiB sends only the changed blocks, both directions, with silent whole-file fallback on any error or older daemon. `deltaSync` setting + reconcile-time temp sweep. |
| 24 | `24_transfer-engine-throughput-and-resume` | ✅ Phases 1–8 built; unit-tested, live-tested against SFTP/FTP/S3/Azure/HTTP servers, and resume after an app kill verified in the real app. Object-store multipart resume works within a session only (object_store 0.11 can't list parts) | Builds on Plan 17's queue and fixes the byte paths: SFTP keeps many reads in flight, object stores get parallel ranged GETs and parallel multipart uploads (plus the 30 s object_store timeout fix), a shared ranged-download engine with work stealing, `.faro-part` temp files with atomic finalize, resume on every backend saved in `faro.db`, a progress-resetting retry budget with a stall watchdog, size and hash checks, speed and ETA, and a separate FTP connection per transfer. |
| 25 | `25_wordpress-backend` | ⬜ | A self-hosted WordPress site as a connection for FTP-only (or no-FTP) hosts where you are a full admin: a one-file Faro Connector plugin, authenticated with core Application Passwords ("Sign in with WordPress" via a `faro://wp-auth` deep link), exposes the whole `ABSPATH` tree as a filesystem over HTTPS plus a curated wp-cli-shaped command set (cache/rewrite flush, plugin toggle, options, cron, debug log, read-only DB query, export, search-replace) for the GUI, `faro-cli wp` and the Agent Bridge. Core-REST-only media tier before the plugin is installed. |
| 99 | `99_scoped-connection-sharing` | 🚫 out of scope | Pulled from the numbered order; slated for removal. Design notes kept on file only. |

Cross-project **Track D** (ServerKit ↔ Faro) has no plan file — it's a
convergence effort tracked only in the Track section below.

---

## Track A — Folder sync (Plan 2)

Continuous "attach a local folder, keep it mirrored" for any backend.

- ✅ **Phase 1–2** — continuous one-way sync (both directions), watcher + poll
  reconciler reusing `sync::plan` + `execute_sync_plan`, Additive/Mirror,
  Settings panel + status pill. *Merged.*
- ✅ **Safety hardening** — exclude patterns + Mirror-delete guard. *Merged
  (`feat/foldersync-safety`).*
- ⬜ **Runtime verification**: drive a live sync (easiest: to a paired phone
  agent). Currently compile/type-verified only.
- ⬜ **Bidirectional + conflict resolution** — needs the state index (Track A2);
  own effort.
- ⬜ **Phase 3 → Plan 9** (on-demand placeholders) — see Track C.

The persistent state index + `change_signal` were **cut out of Plan 2 into
[Plan 3](3_scan-index-foundation.md) (Track A2)** — they're shared with disk
usage, diff, and search, not sync-private.

## Track A2 — Shared scan + index foundation (Plan 3)

The primitives Plans 2, 6, 7, and 8 all quietly need, extracted so they're built
**once**: a reusable **scan engine** (bounded-concurrency `RemoteFs` walk with
progress/cancel + generic / exec-fast-path / object-flat strategy selection) and
a shared **`faro.db`** (SQLite via `rusqlite` bundled, in `AppState`, tables
per-feature). Plus `Capabilities.change_signal` + `DirEntry.etag`. The first
consumer is the folder-sync **state index** (`sync_state`) — same-size-edit
detection, remote-delete vs never-existed, resume-without-re-upload, and the
prerequisite for bidirectional.

- ✅ **Phase 1** — `faro.db` + migrations in `AppState` (`db.rs`, rusqlite bundled).
- ✅ **Phase 2** — extract `sync.rs::walk` → `scan.rs`, bounded-concurrency, with
  progress/cancel hooks; `sync::plan` calls it.
- ✅ **Phase 3** — `change_signal` + `etag` across all backends (object stores
  report ETag; SFTP/FTP/local/agent report mtime+size).
- ✅ **Phase 4** — `sync_state` index live in the reconciler: `sync::plan_indexed`
  catches same-size edits (`SyncReason::Edited`), snapshots the source after each
  pass (seed + prune), resume is a no-op. Verified via a real-Db + real-files
  test; a live-backend runtime pass (phone agent / S3) is the remaining check.

Disk Usage (Track F), Diff (Track G), and Search (Track H) build on this — the
scan engine and `faro.db` become additive callers + tables, not new subsystems.

## Track B — More connection backends (Plan 5)

Widen the connection list; each is one `RemoteFs` impl and inherits browse /
transfer / sync for free.

- ✅ Already present (pre-existing): SFTP, FTP/FTPS, S3, **Azure Blob** (via
  `object_store`), Faro Agent, local.
- ✅ **Phase 0** — S3-compatible presets: AWS/R2/B2 + Wasabi, DO Spaces, MinIO,
  Storj, Hetzner, Scaleway, Oracle OCI, IBM COS, Supabase, and a generic
  self-hosted preset. No backend code. *Shipped.*
- ✅ **Phase 1** — native GCS: `object_store` `gcp` feature + one builder, same
  one-builder move that shipped Azure. *Shipped.*
- ✅ **Phase 2** — WebDAV (Nextcloud/ownCloud/Storage Box/generic): new
  `RemoteFs` impl, PROPFIND/GET/PUT/DELETE/MKCOL/MOVE, ETag change signal.
  Verified against a live wsgidav server. *Shipped.*
- ⬜ **Phase 3** — SMB/CIFS (NAS/Windows shares; Azure Files for free). Biggest
  single gap. **Blocked on the Windows dev box:** `pavao` links libsmbclient
  (Samba C lib, no MSVC build) and the pure-Rust `smb` crate is still immature —
  re-evaluate at build time, and it needs a live NAS to verify. NFS as stretch.
- ✅ **Phase 4** — read-only HTTP(S) source: nginx/Apache autoindex browse +
  nginx JSON + direct-URL mode, streaming GET reads, mutations refused. Verified
  against `python -m http.server`. *Shipped.*
- ✅ **Phase 5** — OAuth clouds: shared `oauth.rs` (loopback+PKCE, keychain) +
  **Dropbox, OneDrive, Google Drive, and Box all shipped** (Drive/Box add an
  ID↔path resolver). Each verified end-to-end against a local mock; going live
  needs a maintainer-registered app client id per provider. Follow-ups: chunked
  upload for Dropbox/Drive/Box, and a delta-cursor capability. *Shipped.*

## Track C — On-demand virtual folders (Plan 9)

OneDrive-style placeholders: files show in the folder, download on open, free-up-
space to evict. Native, per-OS, **Windows-first** (Cloud Filter API).

- ✅ **Windows provider built** behind the off-by-default `virtualfs` feature
  (`src-tauri/src/virtualfs/`): orphan-safe sync-root registration via the Win32
  `CfRegisterSyncRoot` (the WinRT wrapper path needs package identity unpackaged
  Faro lacks — a runtime test caught it), hydration on open through the shared
  `TransferManager` download path via the `cloud-filter` callback machinery, a
  `SyncPair.mode` toggle + Free-up-space UI. Register→unregister round-trip
  verified on real `cldapi`. ⬜ Remaining: manual Explorer verification (hydrate
  on open, free-up-space, badges) — build `--features virtualfs`.
- ⬜ macOS File Provider extension, ⬜ Linux FUSE, or the WinFsp/FUSE virtual-mount
  fallback. *Designed in Plan 9; not built.*

## Track D — ServerKit ↔ Faro convergence (cross-project, greenfield)

Today ServerKit reaches Faro only through the `faro://` deep-link. The natural
next step mirrors DeviceKit: **let a ServerKit-managed host expose a Faro agent**
so servers become first-class, browsable/syncable Faro connections (not just a
prefilled SFTP handoff).

- ✅ Shallow: `serverkit-faro` `faro://connect` deep-link (prefill only, no
  credentials). *Shipped.*
- 🚧 **Delegated access grants** (`faro://grant`): an issuer (ServerKit
  extension) mints a token; Faro consents, generates an on-device key, and
  imports N servers — with optional bastion hop for a static source IP. Open
  protocol in `docs/grant-links.md`, plan in Plan 19. *Faro side in progress;
  ServerKit issuer extension is the follow-up.*
- ⬜ **Deep: embed/expose `faro-agentd` on ServerKit hosts.** Two options:
  (a) ServerKit's Go agent speaks the Faro Noise protocol natively (port a
  minimal `faro-agent-proto` responder to Go), or (b) ServerKit installs the
  existing `faro-agentd` binary as a managed service (it already ships
  cross-platform binaries + a one-line installer). Option (b) is far cheaper and
  reuses everything.
- ⬜ With that in place, **Track A folder sync targets a ServerKit host** for
  free — the payoff of the shared `RemoteFs`/agent design compounds across the
  ecosystem.

Note: ServerKit's own roadmap has "remote app/site deployment through connected
agents" as its open item — Track D dovetails with it (Faro becomes the file/sync
surface for those agents).

---

## Track E — Brand & protocol logos (Plan 14)

Additive icon layer for recognizable brand marks (S3/Azure/SSH/WordPress) via
Iconify, bundled offline. Deliberately does **not** touch the file-type icons
(Material Icon Theme — more complete + has the extension mapping) or the lucide
UI icons.

- ✅ Files already use Material Icon Theme; UI uses lucide. *(shipped/present)*
- ✅ **Phase 1–2** — Iconify offline foundation + protocol logos on the rail,
  connection list, and New-Connection picker (logo *plus* the colour monogram).
  Curated 25-icon offline subset (`gen-brand-icons.mjs`); the build carries zero
  `api.iconify.design` references. Verified headlessly (`verify-brand-icons.mjs`).
- ✅ Phase 3 — vendor logos brand the S3/WebDAV provider presets (Cloudflare,
  Backblaze, DigitalOcean, Oracle, IBM, Supabase, Nextcloud…). ⬜ Phase 4 —
  (deferred) evaluate consolidating lucide UI icons onto Iconify.

## Track F — Disk Usage Explorer (Plan 4)

A WinDirStat/WizTree-style treemap + size-ranked tree, but over **any** backend
(SFTP/S3/FTP/Agent/local) — opens as a workspace tab like the SSH terminal. The
differentiator vs the desktop tools: it works on **remote servers and buckets**,
with a shell `du` fast path (SSH/Agent) and object-store flat listing so it's
actually fast at scale.

- ✅ **Phase 1–2** — a Canvas treemap + size-ranked list on top of the
  **Track A2 scan engine**, opening as a full-screen explorer overlay from the
  file-browser toolbar / a directory's context menu.
  ✅ Phase 3 — exec `find -printf` fast path (SSH + Faro Agent, exec-gated,
  falls back to the walk) + object-store flat listing; the chosen strategy shows
  as a header badge with a fallback note.
  ✅ Phase 4 — reveal / copy-path / delete (live tree prune) from the map +
  colour-by type/depth + rescan. "Remember last scan per connection" deferred
  (the entry point always carries the current dir — no `faro.db` table yet).
  ⬜ Remaining: GUI click-through on a live SSH/S3/agent backend (core scan
  verified at runtime against a real filesystem; app boots clean).

**Built on Track A2** (scan engine + `faro.db`). This is the first *visible*
consumer of the foundation and it's read-only, so it's the lowest-risk way to
prove the walk / exec / object-flat strategies on real backends.

## Track G — Directory Diff (Plan 6)
Meld/Beyond Compare for any two backends (incl. remote↔remote), surfaced in the
**GUI, `faro-cli`, and as an MCP `faro_diff` tool**. Reuses `sync.rs`'s diff +
the **Track A2** scan engine (walks two trees) and its `change_signal`/`etag`
for `--hash` mode. ✅ **All four phases built** — `diff.rs` engine (symmetric
classify + opt-in content-hash pass: server-side `sha256sum` over SSH, streamed
for local/object/FTP), `faro-cli diff <a> <b> [--hash] [--json]` (local↔remote
and remote↔remote), the `faro_diff` bridge/MCP tool, and the GUI two-tree view
(colour-coded rows, class filters, cancellable walks, per-row reveal/copy-path +
copy A→B/B→A via the transfer engine — copy-across needs one local side, as the
transfer engine is local↔remote only). ✅ Runtime-verified: `faro-cli diff`
local↔local with/without `--hash` and `--json` (2026-08-09). ⬜ Remaining:
live-backend run (SSH/S3/agent) + GUI click-through.

## Track H — Fleet Search (Plan 7)
Name + content search across any connection; exec `rg`/`grep`/`find` fast path
on SSH/agent, object-flat name listing on buckets, walk fallback. Reuses the
**Track A2** scan engine (a `faro.db` filename index is a later refinement).

- ✅ **Phase 1–2** — `search.rs` engine: generic name BFS (files + dirs) +
  read-and-grep content walk, then the exec fast path (`rg --json` → `grep -rn`
  → `find -iname`) for SSH/agent and object-flat name search, each falling back
  to the walk with a recorded note. Content on grep-less backends (object/FTP/
  cloud) is opt-in. Verified via the CLI against a real tree.
- ✅ **Phase 4** — `faro-cli search` (direct) + the `faro_search` bridge/MCP tool
  and `faro-cli agent search` upgraded to content grep.
- ✅ **Phase 3** — GUI Fleet Search panel (streaming `SearchManager`, Name|Content
  toggle, grouped content previews), opened from the folder context menu /
  toolbar. ⬜ Remaining: GUI click-through on a live SSH/S3/agent backend (engine
  verified at runtime; app boots clean).

## Track I — Fleet Skills (Plan 8)
Reusable, parameterized, **AI-authorable** automations over the fleet, MCP-native
(the AI composes/saves Skills, then runs them across servers). Builds on the
bridge's existing saved-commands + `faro_exec` + approvals. Safety-gated.

- ✅ **Phases 1–3** — Skills store + fleet runner in `bridge.rs`: `Skill`
  model (params/steps/targets/status) persisted in `bridge.json`, existing
  saved commands seeded once into single-step Skills; `op_run_skill` resolves
  targets (all / explicit, run-time override), substitutes `${params}`,
  dry-runs, gates the whole fleet run once (only allow-all auto-approves), fans
  out with bounded concurrency reusing `exec_core`, and aggregates per-target
  success/fail + audit. MCP: `faro_list_skills` / `faro_run_skill` /
  `faro_save_skill` (AI saves land as **proposals** needing one human approval)
  plus a dynamic `skill_<name>` tool per approved skill. REST `/skills` +
  `/skill_run`.
- ✅ **Phase 4** — `faro-cli skill list|run` (dry-run + per-target summary) and
  a GUI **Fleet Skills** panel (browse/author/approve, pick targets, dry-run,
  run, watch aggregated output), opened from the command palette + the Agent
  Bridge panel.
- ⬜ Remaining: a live multi-server fan-out **run** (unit-verified: 15 tests
  incl. the propose→approve safety flow; backend/CLI/frontend compile clean; a
  live run needs the app rebuilt over the running instance + connected exec
  targets — the maintainer's environment).

## Track K — faro-cli & Agent Bridge remote-exec DX (Plan 10)
Sharpens the daily `faro-cli agent …` / MCP remote-exec surface from real
usage-session feedback: a **CLI version-drift check + in-app update prompt/
auto-update** (the app and `faro-cli` ship separately, so the CLI silently lags
after an app update), `agent script`/`--stdin` (run a local script verbatim — no
base64/heredoc gymnastics), `agent write` (drop text to a remote file directly),
a Git-Bash path-mangling guard, background/detached exec with a pollable job id
(retires the `nohup`+poll loop), and an authenticated `fetch` for pages behind
HTTP Basic Auth (reuses Plan 5's `HttpFs`). Touches `faro-cli`, `bridge.rs`,
`faro-agentd`, and the app's settings/status surfaces; **Phase 0 (version drift)
is the priority — a live pain point, do before the polish plans.** ✅ **All six
phases built.** Phase 4 background jobs land on both arms — SSH (per-job
`~/.faro/jobs/<id>` dir) and paired agents (daemon `ExecStart/Poll/Kill`, an
additive protocol op so older daemons keep working). Verified by unit +
end-to-end tests; live smoke tests against a real SSH box and the paired phone
agent are the maintainer's step (single-instance lock + Android daemon redeploy).

## Track L — Terminal depth & snippets (Plan 11)
Makes the terminal a first-class surface:
an xterm **instance registry** decoupled from React (scrollback survives
remounts/popouts/HMR), **split panes** opening extra PTY channels on the same
pooled SSH connection (Cmd+D family, layout tree), terminal-over-agent as an
additive protocol op (stretch), and **command snippets** (`faro.db` table,
`{{variable}}` templates, Cmd+K insert into the shell — the everyday
low-friction counterpart to Fleet Skills).

- ✅ **Phase 1 — instance registry** (`src/lib/terminalRegistry.ts`): xterm
  instances + their DOM nodes live outside React; leaves attach/detach the cached
  node, disposal is store-driven, HMR-safe. Scrollback survives tab switches,
  dock toggles, splits, popouts.
- ✅ **Phase 2 — split panes**: each tab owns a layout tree (leaf | split), split
  right/down open a new PTY channel on the same pooled SSH connection, with
  draggable dividers, zoom, close-pane, and `mod+shift+D/E/Enter/W` chords
  (palette + cheat-sheet; xterm swallows them so bare Ctrl+D stays EOF).
- ✅ **Phase 4 — command snippets**: `snippets` table in `faro.db` (v2 migration)
  + `snippet_list/save/delete/run`, a Snippets panel, a Cmd+K section, a terminal
  toolbar quick-insert, and a `{{variable}}` fill-in dialog (never auto-submits;
  multi-line warns). Backend unit-tested; the whole UI verified end-to-end in a
  headless browser via the mock harness (`scripts/verify-terminal.mjs`).
- ⬜ **Phase 3 — terminal over the Faro Agent** (stretch, deferred): additive
  `faro-agent-proto` PTY op + `faro-agentd` + `supportsTerminal =
  sftp || agent(supports_pty)`. Left for a session with a paired phone + rebuilt
  daemon — its verification (interactive `top`/`vi`) can't be reached from the
  dev box or the mock harness.

## Track M — Security, settings & portability (Plan 12)
Trust fundamentals: **keychain-everything
credentials** (the Anthropic API key leaves plaintext localStorage; the
frontend never sees secrets — Rust fetches at use time), settings moved from
localStorage into **`faro.db` with pre-paint window injection** (one source of
truth, no theme flash), **structured `{kind, message}` errors** across IPC so
toasts pattern-match instead of regexing strings, and **encrypted
backup/restore** (Argon2id + AES-256-GCM container carrying profiles,
`faro.db`, and all keychain credentials).

- ✅ **Phase 1 — keychain the API key**: `credentials` module + one-way
  `set_api_key`/`api_key_status`, `agent.rs` reads the key at call time, a
  one-time localStorage→keychain migration, and a keychain manifest table so the
  backup can enumerate secrets. Real Windows Credential Manager round-trip
  verified.
- ✅ **Phase 2 — settings in `faro.db`**: `settings` table + commands, the main
  window built in `setup()` with an `initialization_script` that sets
  `data-theme` before first paint, store seeds from the injection, one-time
  localStorage→DB migration (migrate-then-verify). Verified: app boots with the
  programmatic window; the real DB migrated 22 settings rows.
- ✅ **Phase 3 — structured errors**: `FaroError {kind, message}` + classifier;
  `remotefs` file ops + `connect` migrated; frontend `errors.ts` with a
  kind-keyed `toastError`. Verified via a headless harness
  (`scripts/verify-errors.mjs`): auth→reconnect, network→check-connection,
  legacy strings still generic.
- ✅ **Phase 4 — encrypted backup/restore**: `FAROBAK\x01` container (Argon2id
  64 MiB + AES-256-GCM, header as AAD), carrying profiles + WAL-safe `faro.db`
  snapshot + configs + all keychain credentials; staged restore applied at
  startup; Settings danger-zone UI + `faro-cli backup export|import`. Verified
  via the real CLI binary (round-trip + real-data export + wrong-password
  rejection).

## Track N — Remote previews & protocol depth (Plan 13)
Headlined by **lazy remote image previews** (a real user ask): global +
per-connection setting (default off for remote), IntersectionObserver-driven
fetching with a hard concurrency cap, cancellation on scroll-away, size guards
and an LRU disk cache keyed by change signal — scrolling a 100k-image
`wp-content/uploads` costs only the rows you actually see. Plus **native
drag-out download** (the `drag` crate stages to temp; HTML5 DnD can't leave a
webview), an **SCP fallback** for SFTP-less servers, **port forwarding** with
persisted rules + presets, and **Docker SSH E2E fixtures** (bastion / SCP-only
/ sudo) to finally retire the roadmap's "compile-verified only" refrain.

- ✅ **Phase 1 — lazy remote image previews.** `preview.rs` PreviewManager +
  `preview_thumbnail`: a bounded per-`Session` `read_head` (SFTP/object/FTP/
  WebDAV/HTTP/agent/local, capped at 25 MiB), Rust decode+downscale (`image`),
  and an LRU disk cache (`thumb_cache` in faro.db, 256 MiB budget, keyed by
  change signal so edits invalidate). Frontend: default-off `remoteImagePreviews`
  setting + a per-pane toolbar toggle, an AbortSignal from the row's
  IntersectionObserver (scroll-away cancels before dispatch) + a per-connection
  concurrency limiter, raster/size guards; grid **and** list/detail rows preview.
  Backend unit-tested; the full UI flow runtime-verified headlessly
  (`scripts/verify-previews.mjs`): off→icons, toggle→thumbnails for on-screen
  image rows in grid+list, non-images stay icons, toggle-off reverts.
- 🔄 **Phase 3 — SCP fallback (protocol foundation).** `scp.rs` wire protocol
  (`download_to`/`upload_from` over a generic `AsyncRead+AsyncWrite`,
  unit-tested via `tokio::io::duplex`) + `SshSession::scp_download_to`/
  `scp_upload_from`/`sftp_available`. ⬜ Remaining: an ScpFs that browses via the
  shell, a New-Connection "SCP mode" toggle, and routing SSH transfers through
  it when SFTP is off — best verified against the Phase 5 busybox fixture.
- ⬜ **Phase 2** — native drag-out download (the `drag` crate stages to temp).
- ⬜ **Phase 4** — port forwarding (persisted `forward_rules` + DB presets).
- ⬜ **Phase 5** — Docker SSH E2E fixtures (bastion / SCP-only busybox / sudo).

## Track J — Scoped connection sharing (Plan 99, was 15) — OUT OF SCOPE
Share a box read-only / path-jailed / time-boxed. **Pulled from the numbered
build order and slated for removal** — not being built any time soon (it was
blocked on a login/auth foundation regardless). The plan file survives at
`99_scoped-connection-sharing.md` for its design notes only; do not schedule
work against it. 🚫

## Track O — Keyboard shortcuts & remapping (Plan 15)
Every app's expected shortcut surface: turn the hardcoded command-registry
combos (`src/lib/commands.tsx`) into **data** — defaults + user overrides in
`faro.db` (Plan 12's settings table, pre-paint injection) — with a **Settings →
Keyboard tab** (searchable command list, click-to-record capture, conflict
detection, reset). Then teach the dispatcher (`src/hooks/useShortcuts.ts`) about
**non-modifier keys** with input-focus guards so `F2` rename, `Enter` open,
`Delete`, `Backspace` go-up work in the file browser, and make the terminal
chords (`terminalChords.ts`) remappable too. Independent polish; pairs naturally
with Plan 14 (icons) as a UX-polish batch. ⬜

## Track P — App updater, notifications & PATH install (Plan 16)
The app at v1.3.22 has no self-update path (Plan 10 only covered `faro-cli`),
no OS notifications, and no PATH integration (`install_missing` downloads the
CLI and tells the user to wire PATH by hand). Add `tauri-plugin-updater` with
**signed** artifacts + a GitHub Releases `latest.json` (check on launch,
Settings → About "Check for updates", download-progress → restart),
`tauri-plugin-notification` for a small curated set (transfer batch
done/failed, sync error, edit-in-place save failure) behind an
unfocused-only-by-default toggle, and a **one-click "Add faro-cli to PATH"**
at the per-user level — `HKCU\Environment` on Windows (no admin needed; `setx`
banned for its 1024-char truncation), `~/.local/bin` + a marker-guarded shell
profile line elsewhere — with add/status/remove. Key custody is the main
updater risk; PATH writes keep a `faro.db` backup so remove = restore. ⬜

## Track Q — Transfer queue depth (Plan 17)
`TransferManager` spawns every transfer immediately — `Queued` is a label, not a
queue; `cancel` is the only control. Turn it into a real queue: bounded
concurrency (semaphore + FIFO, reorderable), per-transfer pause/resume
(park at a chunk boundary, resume re-runs the file), manual + classified
auto-retry (Plan 12 error kinds), and a global token-bucket bandwidth throttle.
All checkpoints live in the *shared* copy loops so the 11 backends get it for
free. Panel gains pause/retry row actions, pause-all, and a throttle input. ✅
**Built** — all four phases: FIFO + semaphore admission (`transferConcurrency`,
live-adjustable), per-transfer `PauseGate`s with chunk checkpoints in every
copy loop (resume re-runs from byte 0), manual + auto retry (Network/Timeout,
5s/20s backoff, classified via `classify_message`), global `TokenBucket`
(`transferThrottleKbps`, live). Panel: pause-all, throttle input, row
pause/resume/retry/↑↓ with queue positions; Settings → Transfers for the two
defaults. Unit-tested (bucket pacing, FIFO skip-paused, checkpoint restart,
retry classification); `scripts/verify-transfers.mjs` drives the panel
headlessly. Remaining: a live-backend smoke run (real SFTP/S3 batch).

## Track R — Jump hosts & Zero-Trust connectivity (Plan 18)
Locked-down servers (IP allowlists, Cloudflare Tunnels) are unreachable to
Faro today: `ssh_connect` only does direct TCP. Add a `jump_host` profile
reference so any SSH profile can serve as a bastion — russh's
`channel_open_direct_tcpip` + `connect_stream` make it the native `ssh -J`
mechanism with per-hop auth and host-key prompts for free — with the jump
chain held alive inside `SshSession` and rebuilt on reconnect. GUI gets a
jump-host dropdown, the OpenSSH importer learns `ProxyJump`, and an optional
later phase spawns `cloudflared access tcp` for Cloudflare-fronted hosts
(the manual `localhost:<port>` flow works today with zero code). SFTP, SCP,
terminal, `faro-cli`, and the Agent Bridge all inherit it through the single
connect choke point; `faro-agentd` (non-SSH transport) is out of scope.
Verified against Plan 13 Phase 5's bastion Docker fixture. ⬜

## Track S — Find Duplicates & cleanup (Plan 22)
Faro's rename-on-conflict policy leaves `name_1.ext` copies scattered through
real trees; this surfaces them. `dedupe.rs` groups a walked tree two ways —
same-dir normalized-name + equal size (cheap default), or content hash
anywhere in the tree (opt-in, reuses Plan 6's `hash_path`) — and suggests a
keeper per group; deletion is always explicit and per-surface. Surfaced as a
GUI "Find duplicates" panel (review + confirm-then-delete), `faro-cli dedupe`
(`--hash`/`--json`/`--delete --yes`), and the read-only `faro_dedupe` MCP tool.
✅ Built; unit-tested + CLI runtime-verified locally (2026-08-09). ⬜
Remaining: live-backend run + GUI click-through.

## Near-term quick wins (small, high-value)
- **Editable permissions dialog** — today Properties *shows* mode read-only; add
  a FileZilla-style chmod editor (rwx checkboxes + octal). Backend (`chmod_path`,
  `can_chmod`) already exists. Also the visual foundation for idea #10
  (permissions/security view).
- **CLI conflict policy** — expose `--overwrite` / `--on-conflict
  overwrite|skip|rename` on `faro-cli` single-file `upload`/`download`/`cp`
  (only `upload-dir` has it today; default is rename). Backend `OverwritePolicy`
  already supports all three.

## Recommended global sequence

The plan **file numbers now follow this execution order** (see the build-order
index at the top). The Track sections above are a *thematic* map — their letters
are stable labels, so a Track's `(Plan N)` no longer matches its position in the
alphabet. This list is the order to actually build in; the numbered files are its
mirror.

1. **Track A — runtime test.** Safety hardening is merged; drive a live sync
   (paired phone agent) so the shipped feature is trustworthy. (Small.)
2. **Track A2 — scan engine + `faro.db`.** Build the shared foundation: extract
   the walk into `scan.rs`, stand up SQLite in `AppState`, add
   `change_signal`/`etag`. Nothing user-facing yet — it's the substrate for the
   next three.
3. **Track F — Disk Usage (Plan 4).** The first *visible* consumer of the scan
   engine + DB, and read-only (zero risk to shipped sync). Proves the walk /
   exec / object-flat strategies on real backends before the sync engine takes a
   hard dependency on them. Best payoff-to-risk win on the board.
4. **Track A2 — state index live.** Now layer the `sync_state` index into the
   folder-sync reconciler on the foundation Disk Usage already exercised.
   Robustness + unlocks bidirectional.
5. **Track B Phase 0/1/2** — S3 presets + WebDAV + SMB. Biggest coverage gain,
   no OAuth, all fit the trait. Independent of the DB — can interleave anywhere.
6. **Tracks G + H — Diff + Search.** Same scan engine, new surfaces (GUI + CLI +
   MCP `faro_diff` / `faro_search`).
7. **Track K — faro-cli remote-exec DX (Plan 10).** Independent of the scan
   foundation, so it can slot in here — and its **Phase 0 (CLI version-drift
   check + update, exec-ceiling fix) is a live pain point that can be pulled
   forward at any time.** Ships before the polish/deferred plans (iconify #14,
   keyboard shortcuts #15).
8. **Track M — Security, settings & portability (Plan 12).** Trust
   fundamentals; the localStorage API-key fix is small and should land early.
9. **Track L — Terminal depth & snippets (Plan 11).** The biggest everyday-UX
   win; independent of the scan foundation and of Plan 12.
10. **Track N — Remote previews & protocol depth (Plan 13).** Phase 1 (lazy
    previews) is the user-facing headline; its E2E fixtures phase then serves
    the whole roadmap's live-verification backlog.
11. **Track D option (b)** — ServerKit installs `faro-agentd` as a managed
   service; every server becomes syncable via Track A.
12. **Track C Windows on-demand** — the large, later effort.
13. **Track R — Jump hosts & Zero-Trust connectivity (Plan 18).** Small,
    high-leverage, and independent of the scan foundation — one backend
    function plus a dropdown. Can be pulled forward whenever a locked-down
    server blocks real work; its E2E verification leans on Plan 13 Phase 5's
    bastion fixture, so it lands after (or together with) that.

To execute any of these tracks end-to-end in a fresh session, use the local
`docs/plans/prompt.md` runbook — set its one plan-filename knob and paste it.

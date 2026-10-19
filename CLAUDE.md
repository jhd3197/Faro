# Faro — working agreement

Faro is a Tauri 2 desktop client that unifies SFTP/SSH, FTP/FTPS, S3-compatible
object storage, and Azure Blob behind one connection list and one `RemoteFs`
trait — a dual-pane file manager, terminal, transfers, folder sync, in-place
remote editing, and an Agent Bridge that lends a live session to a local agent.
See `PRODUCT.md` for the full pitch.

- **Backend:** Rust in `src-tauri/src/`.
- **Frontend:** React 18 + TypeScript + Zustand + Tailwind in `src/`.

## Git & release workflow — read this first

**Two branches, nothing else: `main` and `dev`.**

- **Do all work on `dev`.** Never create per-feature branches (`feat/…`, `fix/…`,
  `chore/…`) — stay on `dev`.
- **Commit locally; never push.** Make small, focused commits on `dev` as you go.
  **Do not `git push`, do not merge into `main`, do not open PRs.** The maintainer
  reviews the local commits and pushes / merges to `main` himself.
- **`main` is the release branch.** Every push to `main` auto-cuts a public
  release (`.github/workflows/release.yml`); `[skip ci]` in the commit message
  pushes without releasing. Because a push to `main` ships to users, that step is
  always the maintainer's — not yours.
- **Shipping a slice = `dev` → `main`, done by the maintainer.** When a slice is
  complete and verified, say so. If a PR write-up helps, run the **`create-pr`**
  skill — it only *writes a description file* to `.pr/`, it does not open or push
  anything.
- Use the configured Git author. Do not add AI/model `Co-Authored-By` trailers
  unless Juan explicitly requests an accurate attribution for that commit.
  Never copy a model name from earlier commits or repository instructions.

### PR titles are plain English

No conventional-commit prefixes in PR titles — no `feat(scope):`, `fix:`, or
`[tag]`. Write a normal, human title: `Folder sync: exclude patterns and
mirror-delete guard`, not `feat(sync): add exclude patterns`. Faro cuts a patch
release on *every* push to `main` regardless of wording, so the prefix never
carried release weight here. The `create-pr` skill produces titles in this style.

## Autonomy — decide, don't ask

The plans in `docs/plans/` are the spec. Execute end-to-end without checking in at
every step. Don't ask which phase is next, whether to commit, or what to name
things — pick the sensible default (mirror the existing code) and proceed. Only
stop to ask when genuinely blocked: the plan contradicts the code irreconcilably,
an action is destructive/irreversible (data loss, history rewrite), or you need a
secret only the maintainer has. Batch questions; don't drip them. Progress over
permission — implement, commit locally, verify, move on, report at the end.

## Build / verify

Windows dev box. **Force the rustup MSVC toolchain onto PATH** or Rust builds fail
with dlltool/E0514 (Chocolatey shadows it):

```bash
export PATH="$HOME/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin:$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo check -p faro     # backend type-check
cargo build -p faro                     # full compile + link
```

Frontend: `npx tsc --noEmit` (repo root) must exit 0.

**"Compiles" is not "works."** Smoke-test the real flow a change touches:
`npm run tauri dev` launches the app. If the agent is involved, a paired Android
phone runs one — `adb forward tcp:8722 tcp:8722` reaches it at `127.0.0.1:8722`.

**Definition of done (per slice):** `cargo check -p faro` clean · `npx tsc
--noEmit` exit 0 · a real runtime observation of the new behavior · committed
locally on `dev` (not pushed).

## Where things live

- **`RemoteFs`** (`src-tauri/src/remotefs/`) — metadata + mutation only
  (`list_dir, rename, delete, create_dir, chmod, capabilities`). **No byte
  transfer** — that's `TransferManager` (`src-tauri/src/transfer.rs`).
- **Sync:** `sync::plan(...)` (`src-tauri/src/sync.rs`) →
  `commands::execute_sync_plan(...)`. Continuous folder sync engine:
  `src-tauri/src/foldersync.rs`.
- **Stateful subsystems** follow the shape of `src-tauri/src/agent_host.rs`
  (`load / persist / auto_start_if_enabled / start / stop / status`, JSON config
  under the app data dir, `"subsystem://event"` via `tauri::Emitter`), registered
  in `src-tauri/src/lib.rs`.
- **Frontend wiring:** typed IPC wrappers in `src/lib/ipc.ts` (never raw
  `invoke`/`listen` in components); Zustand stores in `src/stores/` (model new ones
  on `bridgeStore.ts`); settings in `src/components/Settings.tsx`; status-bar pill
  + store init in `src/App.tsx`. There is **no system tray** — use the status-bar
  pill.

## Plans & runbook

- `docs/plans/ROADMAP.md` sequences the tracks; numbered plans (`1_…` … `15_…`)
  are the specs, **numbered in build order** (see the ROADMAP's "Plan build
  order" table). E.g. `docs/plans/5_additional-backends.md` adds one `RemoteFs`
  impl + `Session` variant + New-Connection UI entry per backend.
- `docs/plans/prompt.md` is a local (gitignored) one-shot runbook for pasting into
  a fresh session to execute a single plan; it mirrors the rules above.

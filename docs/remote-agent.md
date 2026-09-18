# Faro Remote Agent (Faro-to-Faro bridge)

Control another machine — Windows, macOS, or Linux — from Faro, the way you
already drive a remote server over SFTP/SSH, but **without installing or
configuring an SSH server** on the target. Pair it once with a short code
(RustDesk-style) and it shows up in Faro as a connection you can browse, run
commands on, and transfer files through. Because Faro already brokers its live
sessions to a local AI agent over the Agent Bridge, this immediately lets an AI
model run Windows/macOS commands on any paired machine, from anywhere.

**Two ways to make a machine controllable:**

- **The Faro app itself** (easiest — nothing to download). If the target
  already has Faro installed, open **Settings → Remote control**, flip on
  *"Let my other machines control this computer,"* and click **Show pairing
  code**. The app hosts the agent in-process — no separate binary, no terminal.
  This is the whole answer to "two of my PCs both have Faro."
- **The headless daemon** `faro-agentd` (for servers, VMs, or boxes with no
  GUI). One small binary; run `faro-agentd pair`, read the code. Bundled with
  the installer and service-installable — see [Distribution](#distribution).

Both speak the identical protocol against the same identity/config directory,
so on one machine the GUI host and a headless daemon are interchangeable views
of the same agent (only one holds the port at a time). A running daemon now
**serves paired controllers and accepts new pairings on one port** — pairing no
longer needs a separate mode or a restart.

## Pieces

```
┌───────────────────────┐         paired, end-to-end encrypted          ┌────────────────────────┐
│  Faro (controller)    │◄────────── Noise XX / XXpsk3 over TCP ───────►│  faro-agentd (target)   │
│  Session::Agent        │   len-prefixed, ChaChaPoly-encrypted frames   │  native exec + fs        │
│  AgentFs : RemoteFs    │                                               │  own policy + audit log  │
└─────────┬─────────────┘                                               └────────────────────────┘
          │ Agent Bridge (localhost, existing)
          ▼
   local AI agent (Claude Code, Cursor, …)
```

Three new units, plus wiring into the existing app:

1. **`faro-agent-proto`** — a dependency-light shared crate (no Tauri) with the
   wire protocol: length-prefixed frames, the `Request`/`Response` message set,
   an encrypted `SecureChannel` (Noise via `snow`), a persistent static-key
   `Identity`, and the pairing handshake. Both the daemon and Faro depend on it.
2. **`faro-agentd`** — the headless daemon binary that runs on the target
   machine: loads/creates an identity, advertises over mDNS, accepts paired
   peers, executes requests natively (PowerShell/cmd on Windows, `sh` elsewhere),
   and enforces its **own** local policy + audit log so a compromised controller
   can't silently do more than the machine's owner allowed.
3. **`Session::Agent`** — a new session backend in Faro that speaks the protocol
   as a client, plus `AgentFs : RemoteFs`, transfer arms, and bridge exec
   routing, so the rest of the app treats a paired machine like any other
   connection. A new `"faro-agent"` protocol appears in the connection UI with a
   discovery list + 6-digit pairing flow.

## Security model

- **End-to-end encryption independent of any relay.** The channel is a Noise
  handshake (`snow`, ChaChaPoly + SHA256 + X25519). A future rendezvous/relay
  server can move bytes but can never read or inject commands.
- **Pairing is an explicit consent ceremony.** The daemon prints a 6-digit code;
  the controller must prove knowledge of it. The code is mixed into the handshake
  as a PSK (`Noise_XXpsk3`) so it authenticates the channel (an active
  man-in-the-middle has a different handshake hash and the PSK check fails).
  After pairing, **both sides pin each other's static public key**; subsequent
  connections use plain `Noise_XX` and verify the remote key equals the pin —
  the code is never needed again and an unpinned peer is refused.
- **The controlled machine keeps its own policy.** `faro-agentd` decides what it
  will do (read-only, allow-exec, allow-write) regardless of what the controller
  asks, and logs every operation. Pinned keys, policy, and the audit log persist
  in the daemon's config dir.
- **Transport still starts on the LAN.** v1 discovers peers over mDNS
  (`_faro-agent._tcp`) and connects directly by IP:port — no servers, no port
  forwarding for same-network machines. Internet-wide reach (rendezvous + NAT
  hole-punch + relay fallback) is a later phase and a natural ServerKit upsell;
  nothing in the crypto or message layer changes when it lands.

## Message set (`faro-agent-proto`)

`Request`/`Response` are serde-tagged enums exchanged as encrypted frames:

| Request            | Does                                             |
|--------------------|-------------------------------------------------|
| `Ping`             | liveness                                         |
| `SystemInfo`       | os, hostname, arch, shell, cwd                   |
| `ListDir{path}`    | directory entries (name/kind/size/mtime/mode)    |
| `Stat{path}`       | one entry's metadata                             |
| `ReadFile{path,max}`| capped whole-file read (text preview)           |
| `ReadChunk{path,offset,len}` | ranged read (download streaming)       |
| `WriteChunk{path,offset,data,truncate,done}` | ranged write (upload)  |
| `Delete{path,recursive}` / `CreateDir` / `Rename` / `Chmod` | fs mutations |
| `Exec{command,timeoutMs,maxBytes}` | run a native shell command       |
| `ExecStart{jobId,command,maxBytes}` | launch a detached background job |
| `ExecPoll{jobId}` / `ExecKill{jobId}` | poll / kill a background job    |
| `Signature{path}`   | CDC chunk signature of a file (delta sync)      |
| `DeltaAssemble{basis,patch,recipe,dest,expectedHash}` | reassemble dest from basis + patch, hash-verify, atomic rename |

The `ExecStart`/`ExecPoll`/`ExecKill` trio is **additive** (Plan 10 Phase 4) — a
pre-Plan-10 daemon doesn't recognise it, so the controller degrades to a clear
"update the agent" message rather than a silent failure. The protocol version is
unchanged, so every existing op keeps working against an older daemon.

Every logical message is JSON, split into ≤64 KiB Noise segments (each with a
continuation flag) so large directory listings and file chunks stream safely
under Noise's per-message size limit.

## Delta sync

Transfers to and from a paired machine are **block-level differential**
(Plan 23): re-transferring a changed file of 8 MB or more sends only the
changed blocks instead of the whole file, in both directions. Both sides
chunk content identically (FastCDC + BLAKE3), so the app diffs the remote
file's chunk signature against the local copy, moves only the unmatched
bytes, and the receiver reassembles + hash-verifies + atomically renames —
the destination is never partially written.

There is **nothing to configure** (an opt-out toggle lives in Settings →
Transfers). The one requirement is that the app and the daemon come from the
same release train: an older `faro-agentd` doesn't recognise the new ops, and
the transfer **silently falls back to a whole-file copy** — no error, no data
loss, just no savings. Every other backend (SFTP, S3, FTP, …) always uses
whole-file copies.

## Agent Bridge ops on a paired machine

Once a paired machine is connected in Faro and granted agent access, the local
AI agent reaches it through the same bridge tools it uses for SSH servers
(each gated by the per-op approval flow):

- **`faro_exec`** — runs in the daemon's native shell (PowerShell on Windows,
  `sh` elsewhere). Takes an optional `timeoutMs` (default 60 000 ms, clamped to
  1 s – 15 min; `faro-cli agent exec --timeout-ms …`); output is capped at
  512 KiB.
- **Background jobs (`--detach`, SSH-only)** — for work that runs longer than a
  timeout is comfortable (backfills, migrations), `faro_exec` with `detach=true`
  (`faro-cli agent exec <server> --detach "<cmd>"`) launches the command
  server-side and returns a `jobId` **immediately** instead of blocking. The
  command keeps running under `setsid`/`nohup` in a per-job dir
  (`~/.faro/jobs/<id>/{cmd,out,err,exit,pid}`), surviving even a bridge restart.
  Poll it with **`faro_job`** (`faro-cli agent job <server> <id>`), which streams
  the captured stdout/stderr (each capped at 512 KiB) and reports the exit code
  once finished; `faro-cli agent jobs <server>` lists running/finished jobs. Job
  dirs older than 7 days are pruned on the next launch. This retires the manual
  `nohup … & ; tail -f log` loop. Gated as an Exec (never auto-approved except by
  allow-all); polling is a Read.
- **Background jobs on a paired Faro Agent** — the same `--detach` / `faro_job`
  surface works against a paired machine: the daemon spawns the command, tracks
  it by id in memory (capped output per stream, finished jobs reaped on a TTL),
  and answers `ExecPoll` with the capture + exit code. The one difference from
  the SSH arm: agent jobs live only for the daemon's lifetime — a daemon restart
  forgets in-flight jobs (a later poll returns "no such job"), whereas the SSH
  arm's on-disk `~/.faro/jobs` dir survives one. Requires **faro-agentd from
  Plan 10 or newer** on the target; an older daemon doesn't know the op and the
  bridge reports a clear "update the agent" error. `agent jobs` (list) stays
  SSH-only for now; poll agent jobs by id.
- **`faro_exec_script`** — runs a whole **multi-line script verbatim**
  (`/exec_script`, `faro-cli agent script <server> <file>` or `agent exec
  --file/--stdin`). The script bytes are read locally and shipped as an opaque
  base64 payload, so heredocs, nested quotes and newlines survive with no
  base64/quoting gymnastics on the caller's side. Same 512 KiB cap and the same
  approval gate as `exec` — but, like a Write, **never** auto-approved by the
  safe-read-only heuristic (only allow-all), since a script is multi-statement.
- **`faro_write`** — write text straight into a remote file (`/write`,
  `faro-cli agent write <server> <path> [--from-file|--stdin|--content]
  [--overwrite]`) with no local staging file and without the mangling-prone
  upload path — SSH streams via SFTP `create`, a Faro Agent via a ranged
  `WriteChunk`. Gated as a Write (never auto-approved except allow-all); refuses
  to clobber an existing file unless `overwrite`. Bounded by the ~1 MiB
  request-body cap — for large files use `faro_upload`.
- **`faro_read_file`** — capped file read via the daemon's `ReadFile`.
- **`faro_list_dir` / `faro_search` / `faro_download` / `faro_upload`** — file
  ops through `AgentFs` and the transfer engine (uploads stream as ranged
  `WriteChunk`s).
- **`faro_upload_dir`** — uploads a whole local tree (`/upload_dir`,
  `faro-cli agent upload-dir`). ONE approval covers the tree; the prompt names
  the file count, total bytes and overwrite mode. Collisions rename by default
  (`overwrite=true` replaces).
- **`faro_sync`** — one-way directory sync (`/sync`, `faro-cli agent sync`),
  push or pull, additive or mirror, with `dryRun` returning the capped
  per-file plan. Executing gates once with the copy/byte/delete counts in the
  summary; mirror deletes are always named, and as a Write the gate is never
  auto-approved by the read/safe-exec policies (only allow-all).
- `faro_glob`, `faro_tail` and `faro_read_files_batch` stay **SSH-only** (they
  use `find`/`tail -f`/SFTP); on a paired machine the agent is told to run a
  native equivalent through `faro_exec` instead.

## Running faro-cli from Git Bash / MSYS

Two gotchas hit anyone driving `faro-cli agent …` from Git Bash on Windows:

- **POSIX remote paths get rewritten.** MSYS path conversion rewrites a leading
  `/var/www/html` argument into a Windows path (`C:/Program Files/Git/var/www/…`)
  *before* `faro-cli` ever sees it — so an upload silently lands in a nonsense
  directory. `faro-cli agent upload` / `upload-dir` / `download` / `write` now
  **detect a Windows-drive-prefixed remote path against a non-Windows server and
  refuse it** with a hint instead of uploading. To pass a real POSIX remote path,
  do one of:
  - prefix it with `MSYS_NO_PATHCONV=1`, e.g.
    `MSYS_NO_PATHCONV=1 faro-cli agent upload prod ./app.tar /var/www`;
  - double the leading slash — `//var/www` — which MSYS leaves alone; or
  - drop text straight onto the box with `faro-cli agent write` (no local staging
    file, no upload path to mangle).
- **The CLI can lag the app.** `faro-cli` and `faro-agentd` are **separate
  release downloads** from the desktop app (see Distribution below), so after an
  app update the on-PATH CLI can be older than the running app — advertising flags
  the CLI predates. `faro-cli agent …` compares its build version to the app
  version published in `agent-endpoint.json` and prints a one-line staleness
  warning when it's behind; update with `faro-cli self-update` or from
  Faro → Settings.

## Distribution

There are three ways to get an agent onto the machine you want to control,
easiest first:

1. **The Faro app** (zero download). Settings → Remote control → toggle on →
   Show pairing code. Best when the machine already runs Faro. See the top of
   this doc.
2. **The headless one-liner** (Linux/macOS servers). Downloads the right
   `faro-agentd`, installs it as a service, and opens a pairing window:
   ```sh
   curl -fsSL https://github.com/jhd3197/Faro/releases/latest/download/install-agentd.sh | sh
   ```
   Flags after `| sh -s --`: `--read-only`, `--no-service`, `--dir <path>`,
   `--version <tag>`.
3. **The `faro-agentd` binary** (any platform, most control). Grab it from the
   [release page](https://github.com/jhd3197/Faro/releases/latest), then:
   ```sh
   faro-agentd pair            # serve + print a pairing code (window stays open)
   faro-agentd install         # register a service so it survives reboots
   faro-agentd install --read-only   # …serving browse/read only
   faro-agentd uninstall       # remove the service
   ```
4. **Android phone/tablet** (the `Faro Agent` APK). Same `faro-agentd` stack
   embedded in an Android app, so a phone appears in Faro as a normal
   connection (browse `/sdcard`, transfer, sync; `exec` is a sandboxed non-root
   `sh`, off by default). Sideload the `FaroAgent-*.apk` from the
   [DeviceKit agent releases](https://github.com/jhd3197/DeviceKit/releases?q=agent),
   grant it all-files access, toggle the agent on, tap **Show pairing code**,
   and enter that code in Faro — same 6-digit ceremony as every other agent.
   The APK is built out of the DeviceKit repo (`agent-android`, `faro`
   product flavor); the full DeviceKit fleet agent exposes the same Faro
   screen too.

### Fire TV companion (Fire OS)

The existing **Faro Agent** Android edition is the companion for this workflow;
there is no separate desktop transport to configure. Its source and APK build
live in DeviceKit's `agent-android` project, under the `faro` product flavor.
The Fire TV compatibility changes need a newly built APK; previously published
APKs should not be assumed to contain them.

The current Android and native builds require API 26 or later. This excludes
Fire OS 5 and 6; Fire OS 7 (API 28) and later Android-based Fire OS devices are
the intended TV targets. Vega OS requires a different app package and is not
supported by this APK. Check the exact model and OS in **Settings → My Fire TV →
About**, using Amazon's [device specifications](https://developer.amazon.com/docs/device-specs/identify-fire-tv-devices.html).

1. Install the newly built Faro Agent APK on the TV, then open **Faro Agent**.
2. Grant shared-storage access using the app's permission button, enable the
   agent, and select **Show pairing code**. Keep the PC and TV on the same LAN.
3. In desktop Faro, choose **New Connection → Faro Agent**, select the TV (or
   enter the IP and port shown by the companion), and enter the six-digit code.
4. Newly paired Android connections open `/sdcard` when no custom starting
   folder was chosen. Existing connections can set **Default remote path** to `/sdcard`
   in their connection settings.
5. Use the desktop file panes to transfer files or delete selected downloads.
   **Allow writes** must be enabled on the companion. Shell access is not
   required for file management.

Shared-storage permission does not expose other apps' private data or caches.
Copying an APK transfers a file; installing or uninstalling apps is a separate
device-management feature and is not part of this workflow.

**Device verification remains required:** launch and navigate using only the
remote, grant storage access, pair, upload a disposable file to Downloads,
download it and compare the bytes, rename and delete that file, and reconnect
after sleep and reboot. Build checks and desktop loopback tests do not establish
compatibility with a specific Fire TV model.

### `faro-agentd install` — what it sets up

`install` writes a per-platform autostart entry that runs `faro-agentd run`
(inheriting any `--port` / `--read-only` / `--config-dir` you pass), then starts
it:

| Platform | Mechanism | Scope |
|----------|-----------|-------|
| **Linux** | systemd unit | system unit as root (`/etc/systemd/system`), else a per-user unit (`~/.config/systemd/user`, no sudo — `loginctl enable-linger` to survive logout) |
| **macOS** | LaunchAgent | per-user (`~/Library/LaunchAgents`), `RunAtLoad` + `KeepAlive` |
| **Windows** | Scheduled Task | per-user, runs at logon (`faro-agentd` is a console app, not an SCM service, so a Task is the honest fit) |

Installing changes *when* the daemon runs, not *what* it can do — the service
uses the same identity, pins, and policy as an interactive run.

### Bundling with the installer (planned)

The desktop installer currently ships the GUI; `faro-agentd` and `faro-cli` are
separate release downloads. Because the **embedded agent** (path 1) already
removes the download for the common GUI-to-GUI case, and the **one-liner** (path
2) covers headless servers, bundling the binaries as Tauri sidecars — with an
in-app "install the CLI / run the agent as a service" opt-in — is a follow-up,
tracked in `docs/plans/1_faro-agent-pairing-and-distribution.md` (Phase 3). It's
staged separately so it can't destabilise the push-to-main release build.

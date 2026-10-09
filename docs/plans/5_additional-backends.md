# Plan 5 — Additional connection sources (backends)

## Context

Faro today speaks SFTP, FTP/FTPS, S3-compatible object storage, **Azure Blob**
(both via `object_store`), local disk, and the Faro Agent — each a `RemoteFs`
impl in `src-tauri/src/remotefs/` (`sftp.rs`, `ftp.rs`, `object.rs`,
`local.rs`, `agent.rs`). Because browse, transfer, directory sync, and the
continuous folder-sync engine use common interfaces, a new backend can reuse
their orchestration. Each operation still needs provider-specific implementation
and verification; sharing a trait does not establish feature parity. See
[Plan 26](26_backend-correctness-and-coverage.md) for the safety audit and app/CLI
coverage requirements. This plan widens the connection list, cheapest-first.

Each backend is the same recipe:

1. Implement `RemoteFs` (`list_dir`/`rename`/`delete`/`create_dir`/`chmod` +
   `capabilities` — declare an honest `ChangeSignal`).
2. Add a `Session` variant (`session/mod.rs`) and its connect path.
3. Wire chunked read/write + stat into the `transfer.rs` match arms.
4. Add a New-Connection UI entry (`ProfileEditor.tsx`, `src/lib/types.ts`).

---

## Phases (priority order)

### Phase 0 — More S3-compatible presets (≈ no backend code) — ✅ shipped
`S3_PROVIDER_PRESETS` (`src/lib/types.ts`) + `guessProvider` now ship **AWS,
Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO, Storj, Hetzner
Object Storage, Scaleway, Oracle OCI, IBM COS, Supabase**, and a generic
**S3-compatible / self-hosted** preset (covers Ceph RGW, Garage, SeaweedFS).
Each carries a vendor sub-label, endpoint template, and default region; the
provider grid renders straight from the table and `guessProvider` recognizes
every endpoint pattern. GCS interop mode was skipped in favour of Phase 1's
native auth. (Linode/Akamai and Vultr not added — judge demand.)

### Phase 1 — Native Google Cloud Storage (nearly free now) — ✅ shipped
Shipped exactly as the Azure move: `object_store`'s `gcp` feature +
`gcs_connect` in `session/object.rs` using `GoogleCloudStorageBuilder` with a
service-account key (JSON file path via Key auth, or pasted JSON via Password
auth), protocol `"gcs"`, one `GcsSection` in `ProfileEditor`. A GCS session is
an `ObjectSession`, so browse/transfer/sync/disk-usage/rename all work through
the existing `ObjectFs` + object transfer arms unchanged. No new files, no new
crate.

### Phase 2 — WebDAV (`webdav.rs`) — ✅ shipped
One protocol covers **Nextcloud, ownCloud, Hetzner Storage Box, Koofr, Yandex
Disk, Fastmail Files, Synology WebDAV, and a long tail of generic servers**.
Shipped as `session/webdav.rs` (`WebdavSession`: shared `reqwest` client, base
URL carrying the DAV root, Basic/Bearer auth, connect-time depth-0 PROPFIND
validation) + `remotefs/webdav.rs` (`WebdavFs`: `PROPFIND` list, `MOVE` rename,
`DELETE`, `MKCOL`, no chmod). Byte transfer streams via `GET`/`PUT` in
`transfer.rs`; edit-in-place wired in `editor.rs`. `change_signal: Etag` from
`getetag`, with the mtime+size the entries still carry as the fallback.
- Shipped **WebDAV provider presets** (`WEBDAV_PROVIDER_PRESETS`): Nextcloud /
  ownCloud prefill `…/remote.php/dav/files/<user>/`, Hetzner Storage Box
  `https://<user>.your-storagebox.de`, plus a generic template; the
  `WebdavSection` also has a Basic/Bearer auth toggle.
- Hand-rolled (not `object_store`'s `http` feature) so `has_directories: true`
  is honest. The multistatus parser is namespace-prefix agnostic (Nextcloud
  `d:`, Apache `D:`/`lp1:`, bare); RFC1123 `getlastmodified` is parsed without a
  date crate. Verified by parser unit tests + a live `#[ignore]` end-to-end test
  (connect → MKCOL → PUT → PROPFIND → GET → MOVE → DELETE) against wsgidav.

### Phase 3 — SMB/CIFS (`smb.rs`) + the LAN/NAS tier — ⬜ blocked on Windows
**Build-time re-evaluation (2026-07):** `pavao` links **libsmbclient** (Samba's
C library), which has no practical MSVC build — a hard blocker on the mandated
Windows toolchain — and the pure-Rust `smb` crate is still immature. SMB also
needs a live NAS/Windows share to verify, which isn't available in the dev
environment. Deferred until either the pure-Rust client firms up or a
libsmbclient build path exists. Everything below stands as the original spec.
Windows shares and **every NAS** (Synology, QNAP, TrueNAS). LAN-first, plain
user/pass — no OAuth. Options: [`pavao`](https://crates.io/crates/pavao)
(wraps libsmbclient, C FFI build cost) vs the pure-Rust `smb` crate that has
been maturing — re-evaluate at build time. Optional mDNS/NetBIOS discovery.
Capabilities: real dirs + rename yes, `chmod` no, `change_signal: MtimeSize`.
Biggest single real-world gap for a FileZilla-class tool.
- **Free bonus:** Azure Files shares speak SMB 3 over port 445 — an enterprise
  backend for zero extra code once SMB works.
- **Stretch — NFS:** rounds out the NAS story; Rust client crates (e.g.
  `nfs3_client`) are immature, so read-mostly first or defer until they firm up.

### Phase 4 — Read-only HTTP(S) source (optional mini-phase) — ✅ shipped
Shipped as `session/http.rs` (`HttpSession`: shared `reqwest` client, optional
Basic auth, HEAD reachability probe; connect picks **Listing** vs **DirectFile**
mode from the URL shape) + `remotefs/http.rs` (`HttpFs`: `list_dir` parses
nginx/Apache autoindex HTML — anchor-based, survives the `<pre>` and `<table>`
variants — or nginx JSON; `GET` reads; every mutation returns a read-only
error). DirectFile mode HEADs a pasted file URL and surfaces one entry, so you
can pull a release artifact straight into a pane with no listing. Capabilities:
all mutations `false`, `change_signal: Etag` (from the file's own
ETag/Last-Modified, populated on read/HEAD — a listing carries none). Byte reads
stream via `GET` in `transfer.rs`; edit-in-place opens read-only (save errors).
Verified by parser unit tests + a live `#[ignore]` end-to-end test against
`python -m http.server` in both listing and direct-file modes.

### Phase 5 — OAuth consumer clouds (Dropbox / OneDrive / Drive / Box) — the hard tier
Big user draw, meaningfully harder. Shared infrastructure first:
- ✅ **`oauth.rs` helper** — **shipped and reusable.** Hand-rolled loopback +
  PKCE (S256) authorization-code flow (no `oauth2` crate): a fixed-port
  (`:53682`) local listener catches the redirect, the code is exchanged against
  a configurable token endpoint, refresh is a second form POST. Endpoints are
  `OAuthConfig` fields, so a new provider is just a different config. Tokens live
  in the OS keychain (`keyring`, native backends), never in profile JSON.
- Rate limits + retry/backoff: a transparent 401→refresh-retry is in place;
  broader backoff is future work.

Then sequence by API friction, **not** brand size:
1. ✅ **Dropbox** — **shipped.** API v2 path-based → straight into the trait.
   `session/dropbox.rs` (`DropboxSession`: bearer RPC/content helpers,
   transparent refresh) + `remotefs/dropbox.rs` (`DropboxFs`: list_folder+continue,
   move_v2, delete_v2, create_folder_v2; `rev` as the change token) +
   streaming download / simple upload in `transfer.rs` (>150 MB refused pending
   chunked `upload_session`) + a `dropbox_authorize` command driving the browser
   flow + a `DropboxSection` "Connect with Dropbox" editor. Verified by parser
   unit tests + a live `#[ignore]` end-to-end test (`tests/dropbox_mock.py`)
   covering token exchange, the 401→refresh retry, and
   list/create/upload/download/move/delete.
   **Maintainer prerequisite to go live:** register a scoped Dropbox app
   (<https://www.dropbox.com/developers/apps>), redirect URI
   `http://localhost:53682/`, enable the `account_info.read` /
   `files.metadata.read` / `files.content.read` / `files.content.write` scopes,
   and set the App key in `session/dropbox.rs` (`DROPBOX_APP_KEY`) or via
   `FARO_DROPBOX_APP_KEY`. PKCE ⇒ no app secret. The browser-consent leg needs a
   real app key + account and is the only unverified step.
2. ✅ **OneDrive** — **shipped.** Microsoft Graph path addressing
   (`/me/drive/root:/path:`). `session/onedrive.rs` + `remotefs/onedrive.rs`
   (list + nextLink paging, PATCH move, MKCOL/delete, cTag token) + streaming
   download / simple-or-chunked-session upload + `onedrive_authorize`. Verified
   against `tests/onedrive_mock.py`.
3. ✅ **Google Drive** — **shipped.** Strictly ID-addressed → a path↔ID
   resolver with a cache (`session/gdrive.rs`): `files?q='<parent>' in parents`,
   multipart create / media update, PATCH add/removeParents move, md5 token.
   Verified against `tests/gdrive_mock.py` (nested-path resolver + full CRUD).
4. ✅ **Box** — **shipped.** ID-addressed like Drive, reuses the resolver shape
   (`session/boxdrive.rs`): `/folders/{id}/items`, multipart/form-data upload,
   PUT move, recursive delete, sha1 token. Verified against `tests/box_mock.py`.
5. *(Optional, not built)* **pCloud** — path-based API, small effort, smaller
   audience.

### Phase 6 — Shopify (themes as a filesystem) — ✅ shipped (Plan 18 Phase 1)
Shipped per **`docs/plans/18_shopify-backend.md`**, following this plan's
recipe exactly: `session/shopify.rs` (`ShopifySession`: Admin REST client,
~2 req/s pacing + 429 `Retry-After` + 5xx backoff, static Admin token or
client-credentials exchange cached with a 5-min margin, credential in the OS
keychain as `shopify:{profile_id}` — no OAuth loopback) + `remotefs/shopify.rs`
(`ShopifyFs`: themes as root dirs, directories inferred from asset-key
prefixes, rename = PUT+DELETE, `.faro-keep` placeholders for mkdir, no chmod,
`change_signal: MtimeSize`). In-place Liquid editing rides the editor arms;
`ProfileEditor` gets a non-OAuth `ShopifySection` (store domain + token or
client ID/secret). Verified by unit tests + a live `#[ignore]` roundtrip
against `tests/shopify_mock.py`. Phases 2 (store media) and 3 (content as
virtual files) remain in plan 18.

### Phase 7 — HubSpot (Design Manager / File Manager / HubDB) — ⬜ planned (Plan 20)
Specced in **`docs/plans/20_hubspot-backend.md`**, following this plan's
recipe exactly: one private-app token (`pat-…`, keychain-stored, no OAuth
loopback) over three surfaces in a single connection — the Design Manager via
the Source Code API v3 (a true hierarchical filesystem with draft/published
environments, an even cleaner fit than Shopify's key prefixes), the File
Manager via the Files API v3, and HubDB tables as virtual CSV files
(read-mostly; write-back deferred until row-ID round-tripping is safe). Same
throttled-`reqwest`-session shape as Shopify (shared per-portal quota).

All four reuse `oauth.rs` (loopback+PKCE+keychain) and the shared
`RefreshingToken` (proactive refresh + 401-retry). Each needs the same
maintainer step to go live: register the provider app with redirect
`http://localhost:53682/` and set its client id
(`{DROPBOX,ONEDRIVE,GDRIVE,BOX}_CLIENT_ID` constant or `FARO_*_CLIENT_ID`).
Every provider's OAuth-token/API path is verified against a local mock; the only
unverified leg is the interactive browser consent, which needs a real app + account.

**Not yet done:** the **delta-cursor** capability. Dropbox
(`list_folder/continue`), Graph delta, and Drive `changes.list` could surface as
a push/delta signal so folder-sync skips polling — a follow-up (needs a new
`Capabilities` field + sync-engine support), not part of the RemoteFs pilot.
**Chunked upload** is only implemented for OneDrive; Dropbox refuses >150 MB and
GDrive/Box buffer the file for multipart — a follow-up for very large files.

### Phase 8 — WordPress (REST API as a filesystem) — ✅ shipped (Plan 25)
Shipped per **`docs/plans/25_wordpress-backend.md`**, same recipe: an
Application Password (Basic auth, keychain as `wordpress:{profile_id}`, no
OAuth) over the site's REST API. `session/wordpress.rs` (discovery with a
`?rest_route=` fallback, admin check, shared throttle) + `remotefs/wordpress.rs`
(`media/` = the media library; `rest/` = every namespace, collection routes as
directories of `{id}.json`, singles as `{name}.json`; save = PUT with a
stale-save check, core routes get only the edited fields). Adds
`Capabilities.has_commands`, `faro-cli wp`, `fetch -X/-d/-H`, and the
`faro_wp_rest` bridge tool. Verified live against WordPress in Docker
(`src-tauri/tests/wordpress/setup.sh`) and in the real app.

### Considered and passed (for now)
- **Mega** — client-side crypto protocol, no sane Rust path.
- **Proton Drive / iCloud Drive** — no official public API.
- **rsync daemon** — wire-protocol effort exceeds payoff; folder sync over
  SFTP already covers the use case.
- **Git repos / artifact registries** — different mental model; if ever, as a
  Plan 9 virtual folder, not a `RemoteFs`.

---

## Cross-cutting
- Each backend declares honest `Capabilities` — sync and UI rely on
  `change_signal` (`Etag` for WebDAV/object/HTTP, `MtimeSize` for SMB/NFS),
  `has_directories`, and rename semantics. `has_shell` stays `false` for
  everything in this plan.
- **`transfer.rs` refactor before the backend wave:** each `Session` variant
  today appears in ~6 match arms (read/write streams, stat, fs construction).
  Fold those into session-level helpers first so a new backend is one impl,
  not six scattered diffs.
- **OS keychain** (`keyring` crate or Tauri plugin) for passwords and OAuth
  tokens — prerequisite for Phase 5, nice-to-have before it.
- **OpenDAL option:** Apache `opendal` ships WebDAV/Drive/OneDrive/Dropbox/Box
  services behind one trait and could collapse Phases 2 + 5 implementation
  cost. Trade-offs: a second abstraction beside `object_store`, uneven
  per-service maturity, and OAuth token acquisition is still ours. Evaluate
  seriously before hand-rolling Phase 5.
- New Connection UI: group backends (SSH family / Object storage / Network
  shares / Cloud drives / Other) as the list grows; presets are a generic
  mechanism (S3 today, WebDAV/SFTP hosts tomorrow).

## Recommended batches
1. **Phase 0 + Phase 1** — presets + native GCS: near-zero code, immediate
   provider-list growth.
2. **Phase 2 + Phase 3** — WebDAV + SMB: the coverage jump that turns
   "SFTP/FTP/object-store client" into "connects to almost any file source on
   a LAN or in the cloud." All username/password, no OAuth.
3. **Phase 5** — OAuth tier once the token infrastructure is worth building,
   Dropbox first. Phase 4 (HTTP) slots wherever a small win is welcome.

## Key files
- new `src-tauri/src/remotefs/{webdav.rs,smb.rs,http.rs,dropbox.rs,onedrive.rs,gdrive.rs,boxdrive.rs}`
- `src-tauri/src/remotefs/mod.rs` (register impls)
- `src-tauri/src/session/mod.rs` + `session/object.rs` (GCS builder; new
  `Session` variants) · `src-tauri/src/transfer.rs` (match arms → helpers)
- new `src-tauri/src/oauth.rs` (Phase 5 shared helper)
- `src/lib/types.ts` (preset tables) + `src/components/ProfileEditor.tsx`
  (grouped picker, new sections)

## Risks
- SMB Rust maturity → possible C FFI (`libsmbclient`) and its build/deploy cost.
- ID-addressed APIs (Drive, Box) fight a path-based trait — resolver/cache
  layer, and path renames invalidate cached IDs.
- Provider rate limits; multipart ETag ≠ MD5 (ties into sync change detection).
- Autoindex HTML parsing (Phase 4) breaks per-server — keep the scope narrow.
- Credential sprawl across many providers → OS keychain integration.
- If OpenDAL is adopted, its per-service quality becomes a dependency risk.

## Verification
Per backend: connect, browse, up/download a file (chunked), rename, delete;
then attach it to a folder-sync pair unchanged to confirm the shipped engine
is truly backend-agnostic.

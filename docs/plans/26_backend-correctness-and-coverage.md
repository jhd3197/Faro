# Plan 26 — Backend correctness and coverage

Status: planned. S3 fixes and regression coverage are tracked in PR #34; the
other work below is not implemented by that PR. This plan follows the connection
types exposed in New connection, plus WordPress and local disk. A connection
appearing in the picker is not evidence that every app or CLI operation works.

## Outcome

For each backend, state which operations are supported, verify them through the
actual app transfer runner and CLI, and return an explicit unsupported error for
the rest. Prioritize preventing wrong-target writes and deletion before adding
features. Keep real-provider checks distinct from emulator and mock results.

## Evidence at the start

These are code findings unless a reproduction is explicitly listed:

| Backend | Current evidence | Immediate implication |
| --- | --- | --- |
| S3 | 55 CLI emulator checks, three live emulator transfer tests; see `docs/s3-testing.md` | Keep this suite running in CI. Wasabi and other providers still need separate smoke tests. |
| Google Drive | `find_child` selects the first matching name; `delete` ignores the recursive flag and uses permanent deletion | Reproduce duplicate-name selection and nonrecursive folder deletion first. |
| Google Drive | App uploads buffer the full file; CLI upload and download explicitly reject Drive | Large-file handling and CLI parity are separate missing features. |
| Google Drive | Basic mock roundtrip covers nested paths, token exchange/refresh and CRUD, but uploads directly through HTTP | It does not prove the real transfer runner, CLI, or browser authorization works. |
| Azure Blob | Non-S3 object backend treats mkdir as a successful no-op and renames one object rather than a prefix tree | Empty-folder and directory-rename semantics need an explicit contract and tests. |
| Azure Blob | An ignored large-object/resume test exists | Run it with Azurite, then add namespace and CLI checks. S3 results do not establish Azure correctness. |
| SFTP | Recursive delete uses following `metadata` on the starting path | Reproduce deleting a symlink to an external directory and ensure target contents survive. |
| FTP | Recursive delete replaces listing errors with an empty list | Reproduce denied child listings and prevent partial deletion after incomplete traversal. |
| FTP/SFTP | Some overwrite probes use `is_ok()` as existence | Test denial and disconnect separately from missing files. |
| Other backends | Several mock roundtrips exist, but no complete operation matrix has been run in this audit | Inventory before claiming support or treating untested behavior as a bug. |

Relevant sources: `src-tauri/src/session/gdrive.rs`,
`src-tauri/src/remotefs/{gdrive,object,sftp,ftp}.rs`,
`src-tauri/src/transfer/{mod,live_tests}.rs`, and
`src-tauri/faro-cli/src/main.rs`.

## Delivery order

### 1. Google Drive safety and test harness

Start with `src-tauri/tests/gdrive_mock.py` and extend it with deterministic
fixtures and request logs. Keep test profiles, tokens, and data isolated from
the user's normal profile store. Do not exercise destructive cases on real data.

1. Duplicate sibling files and folders: never silently choose an arbitrary ID
   for download, overwrite, rename, delete, or sync. Initially fail ambiguous
   path resolution with an actionable error; design ID-based selection for the
   UI as a separate enhancement. Test both cold and warmed resolver caches.
2. Deletion: a nonrecursive delete of a nonempty folder must fail without any
   mutation. Define recoverable trash versus explicit permanent delete, and
   expose that distinction to the caller before changing the default. Verify
   recursive traversal and failure behavior for whichever contract is chosen.
3. Errors: revoked access, permission denial, malformed metadata, failed child
   listing, and token-refresh failure must not become empty folders or missing
   files. A failed source scan must never create a mirror deletion plan.
4. Pagination: multiple pages, empty intermediate pages, malformed/repeated
   continuation tokens, and an error on a later page. Return no partial-success
   result on an incomplete listing.
5. Cache invalidation: external rename, move, deletion, and same-name replacement
   after the cache is populated must not redirect an operation to a stale ID.

Acceptance: each reproduced safety defect has a failing regression before its
fix, then passes through `GDriveFs` and relevant shared scan/sync paths. Assert
untouched sibling IDs, bytes, and mutation logs as well as returned errors.

### 2. Azure namespace and transfer audit

Provide a one-command disposable Azurite lab with a seeded container, test
credentials, automatic teardown, and a JSON result report. Exercise:

- Implicit prefixes, explicit directory markers, empty folders, zero-byte files,
  file/prefix name collisions, spaces, Unicode, percent signs and trailing spaces.
- Paginated listings, missing versus unreadable prefixes, recursive deletion
  boundaries, directory rename, and preservation of source data on copy failure.
- Upload/download byte equality, large block uploads, range downloads, cancel,
  connection loss, changed-source resume, and cleanup after failure.
- CLI copy destinations, diff/hash errors, additive and mirror sync, and the
  actual app transfer runner. Match supported behavior rather than blindly
  assuming Azure has S3's API or marker semantics.

Acceptance: publish the pass/fail/unsupported matrix. Fix reproduced defects;
operations without a reliable implementation must fail explicitly rather than
return success. Keep actual Azure authentication, permissions and account
configuration as separate real-service checks outside the emulator claim.

### 3. Google Drive transfer completeness

After safety is covered:

- Replace whole-file buffering with a bounded-memory upload path. Implement and
  verify the provider's resumable upload flow, including interruption, expired
  upload sessions, token expiry, and cancel/retry behavior without duplicate files.
- Wire CLI upload/download into a shared tested implementation. Verify `cp`,
  sync, hash/diff and error exit codes; retain explicit rejection until supported.
- Specify Google Docs/Sheets/Slides export names and formats, shortcut handling,
  Shared Drive access and permissions, and unusual/duplicate names that cannot
  map losslessly to a local path. Do not turn unsupported items into empty files.
- Validate concurrent token refresh, revoked authorization, rate limiting and
  transient server errors. Retry mutations only when duplicate side effects
  can be prevented or detected.

Acceptance: real runner and CLI tests verify bytes, bounded buffering and request
sequences. Provider-specific features remain marked unverified until exercised
against a disposable real-account fixture. Browser consent and refresh-token
persistence need an explicit real-account smoke test.

### 4. FTP, FTPS and SFTP safety

Create disposable servers and fault fixtures for symlinks, unreadable children,
hidden files, empty directories, Unicode and legacy encodings, overwrite policy,
disconnects, failed saves and transfers. Extend the existing live transfer tests.
Cover FTP MLSD/LIST fallbacks, active/passive mode and connection limits; FTPS
certificate rejection/acceptance; SSH password/key authentication, changed host
keys, reconnect and command exit codes. Verify both app runner and CLI.

Acceptance: no traversal outside the selected tree, no partial-scan deletion,
and no false success. Failed downloads preserve existing local files, and failed
remote saves have documented, tested recovery behavior.

### 5. Cover the remaining connection picker

The following are audit targets, not claims of confirmed defects or support.

| Backend | Starting fixture | Provider-specific cases |
| --- | --- | --- |
| GCS | Object-store contract tests and a disposable service fixture | Credential failures, exact keys, markers/prefixes, pagination, changed-object resume |
| Dropbox | Existing Dropbox mock | Cursor pagination, moves, upload sessions, name conflicts, revoked access |
| OneDrive | Existing OneDrive mock | Item IDs, next links, name conflicts, shortcuts, upload sessions, token expiry |
| Box | Existing Box mock | Duplicate/conflicting names, versions, pagination, permissions, large uploads |
| WebDAV | Local server plus fault responses | Multistatus errors, encoded paths, MOVE conflicts, locks, auth, partial listings |
| HTTP | Local static/range server | Read-only capability enforcement, redirects, absent/wrong lengths, unsupported ranges, changed source |
| Shopify | Existing Shopify mock | Resource pagination, writable versus read-only resources, rate limits, API errors |
| HubSpot | Existing HubSpot mock | Cursor pagination, object/file distinctions, permissions, partial API failures |
| Dynamics 365 | Existing Dynamics mock | Next links, entity metadata, permissions, partial API failures |
| Faro Agent | Disposable agent process | Pairing/auth, path boundaries, permissions, reconnect, ranged writes, platform differences |
| WordPress | Existing WordPress test fixture | Media and resource capabilities, permissions, pagination, blocked endpoints, failed writes |
| Local disk | Temporary directories on each OS | Case collisions, reserved names, long paths, locked files, full disk, symlinks |

For each backend, inventory every CLI match arm and every UI capability first.
List/create/rename/delete support does not establish transfer, preview, search,
editor or sync support. Never generalize a test passing on one provider to all
providers that share a Rust trait.

## Shared operation matrix and test rules

Track connection/auth, browse/pagination, stat, mkdir, upload, download,
overwrite/skip/rename, move, nonrecursive/recursive delete, preview, editor save,
search, disk usage, hash/diff, additive/mirror sync, cancellation and recovery.
Maintain separate columns for app, CLI, mock/emulator evidence and real service.
Use statuses: verified, failing, unsupported, not tested. Attach a test name or
result artifact to each verified cell.

Every supported writable backend must pass these shared safety cases:

1. Missing, denied, canceled, truncated and disconnected operations are distinct;
   none produces a success notification or successful CLI exit accidentally.
2. Exact file bytes and sibling contents survive failed transfers and mutations.
3. Mirror cannot delete after an incomplete scan or failed required copy.
4. Empty folders, hidden files and filename collisions have explicit semantics.
5. Retry/cancel does not leave duplicate work or report a half-completed operation
   as finished; cleanup limitations are documented and tested.

Use ephemeral roots and synthetic credentials. Reports must not contain tokens,
real customer paths, or file contents. Test harnesses fail when required fixtures
are missing; an early return from an ignored test is not a passing integration
result. Bound all waits and inject faults deterministically.

## CI and release evidence

- PR checks: unit/contract tests, TypeScript/build, and lightweight local
  emulator/mock audits; keep assertions tied to bytes and side effects.
- Extend OS coverage for local paths, credential storage and atomic replacement.
- Put expensive large-transfer and reconnect tests in a separately runnable
  workflow with bounded timeouts and saved reports. Do not silently omit them
  from a release validation claim.
- Real-service smoke tests run only with dedicated disposable accounts and
  explicit credentials. They are separate evidence for OAuth, IAM and service
  behavior that local fixtures cannot establish.

## First implementation PR

Keep the first follow-up focused: extend the Drive mock for duplicate names,
nonrecursive deletion and denied listings; add regressions; fix ambiguous
resolution and deletion safety; run through the shared sync scanner; document
remaining unsupported features. Do not combine that safety PR with CLI transfer
support, Shared Drive support or an upload-engine rewrite.

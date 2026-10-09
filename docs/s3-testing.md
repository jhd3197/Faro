# S3 testing and CLI regression coverage

The confirmed audit defects are fixed in this checkout. The expanded CLI audit
passes **55/55 checks**, including injected failures. The app transfer runner
also passes directory, Unicode, and 200 MiB multipart/resume tests. Changes
are local; this document does not imply a released build contains them.

Final validation on Windows: 246 library tests passed (24 ignored; the known
unrelated `ssh_keygen_accepts_generated_key` Windows ACL test was filtered),
7 CLI unit tests passed, all 3 live S3 transfer tests passed, and TypeScript
`tsc --noEmit` passed. The live tests include 200 MiB multipart/ranged transfers
and restart after the remote source changes during a pause.

No AWS account, Wasabi account, Docker, or real credentials are needed. The lab
uses [Moto's S3 HTTP server](https://docs.getmoto.org/en/5.1.12/docs/server_mode.html)
on `127.0.0.1`. Data lives in memory and disappears when the server stops.
Faro connects through its normal S3 client and signs requests with dummy keys.

## Start the lab (Windows / PowerShell)

From the repository root, install into an isolated, git-ignored environment:

```powershell
python -m venv src-tauri/target/s3-lab-venv
src-tauri/target/s3-lab-venv/Scripts/python.exe -m pip install "moto[server]==5.1.12" boto3
src-tauri/target/s3-lab-venv/Scripts/python.exe scripts/s3-lab.py
```

On macOS/Linux use `python3` to create the environment and its `bin/python`
instead of `Scripts/python.exe`. Use `--port 5010` if 5009 is occupied, or
`--check` to verify the API behavior and stop immediately. Stop the foreground
server with Ctrl+C.

Create an S3 connection in Faro using the custom endpoint:

| Field | Value |
| --- | --- |
| Endpoint | `http://127.0.0.1:5009` |
| Bucket | `faro-test` |
| Region | `us-east-1` |
| Access key / username | `faro-test` |
| Secret key / password | `faro-test-secret` |
| Remote path | `/issue-33` |

Download `issue-33` into a fresh local folder. It should contain five files,
including a real zero-byte `empty.txt`, nested folders, a folder with spaces and
an ampersand, and an empty `marked/empty` folder. There should be no transfer
rows for the directory markers and no `object head` errors. Use a build from
this checkout to test the fix; an already-installed release may still have it.

## Automated checks

The wire-format tests start a tiny local HTTP fixture and exercise Faro's actual
S3 XML parser; they run without Moto or cloud credentials:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml -p faro --lib remotefs::object::tests
```

With the lab running, test the same directory listings the GUI uses and copy
every discovered file through Faro's real transfer runner, verifying bytes:

```powershell
$env:FARO_LIVE_S3 = 'http://127.0.0.1:5009:faro-test:faro-test:faro-test-secret'
cargo test --manifest-path src-tauri/Cargo.toml -p faro --lib live_s3_directory_markers -- --ignored --nocapture
```

The existing broader transfer test uploads/downloads 200 MiB, checks multipart
ETags and ranged downloads, then replaces a paused download's source to check
that it restarts safely. It uses temporary local files and unique S3 keys:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml -p faro --lib live_s3_parallel_round_trip -- --ignored --nocapture
```

On Windows, prefer rustup's Cargo if Chocolatey shadows it:
`$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"`.

## Why the directory error happens

S3 represents directories as key prefixes. Some tools also create zero-byte
objects ending in `/`, called folder markers. Listing `issue-33/marked/` with
delimiter `/` returns its marker in `Contents` alongside child objects, and
subdirectories in `CommonPrefixes`.

The `object_store` 0.11.2 parser strips the marker's trailing slash. Faro used
to classify this returned object as a file, then request metadata for
`issue-33/marked`, which is a different, nonexistent key. That explains an
error per marked directory while its child files download successfully.

The S3 namespace adapter now retains raw keys and trailing-slash markers for
listing, rename, mkdir, and deletion, using the storage library's SigV4 signer.
A directory's own marker is excluded from its children. Directory paths retain
a trailing slash so they can be distinguished from same-named file objects.
Streaming file operations use `Path::parse` to preserve names without encoding
them a second time. Real zero-byte files remain downloadable, and HEAD errors
are not suppressed.

The lab checks the distinction directly: HEAD of `marked` returns 404, HEAD of
`marked/` returns 200, and GET of `marked/hello.txt` returns its exact contents.
See [AWS's prefix documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-prefixes.html)
and [HeadObject reference](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html).

## Unicode and special-character keys

The lab seeds `/key-encoding/café.txt`. File metadata, downloads, uploads,
listing, editing, preview reads, and hashes now parse existing keys instead of
percent-encoding their names. The CLI audit covers Unicode, literal `%`, and
`#`, including a marked directory rename with a Unicode/percent filename.

Run the app transfer regression with the lab running:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml -p faro --lib live_s3_unicode_key -- --ignored --nocapture
```

## What the lab proves

It exercises S3 HTTP listing/metadata/download behavior and Faro's transfer
code. Moto is an emulator: it does not establish compatibility with every
Wasabi behavior, real IAM permissions, TLS setup, or network failure mode.
The report is consistent with this reproduced marker bug, but confirmation
against the reporter's actual bucket still requires a Wasabi retest.

### Initial investigation, before the broader fixes (October 8, 2026)

- Before the fix: two marker regression tests failed; the ordinary-prefix test passed.
- After the fix: all three wire-format tests passed.
- Live directory copy: all five files matched exactly, the empty directory was
  preserved, and a genuinely missing file still returned an error.
- Live 200 MiB round trip: multipart upload, ranged download, and restart after
  changing a paused source all passed.
- Unicode reproduction: failed as described above, after direct SDK retrieval
  of the original key succeeded. This was subsequently fixed.
- Full library suite: 244 passed, 24 ignored, one failed. The failure was
  `keys::tests::ssh_keygen_accepts_generated_key`: Windows OpenSSH rejected a
  temporary private key because its inherited ACL allowed `CodexSandboxUsers`.
  No SSH-key code was changed for this investigation.

## Repeatable CLI audit

The baseline audit on checkout `09814d7` (local version 1.3.38, with the first
#33 marker fix) had 30 passing checks and 18 unmet expectations. The completed
fix now passes all 55 checks, including seven additional rename and failure
cases. Some checks verify explicit unsupported-operation errors; passing the
audit does not mean every command supports every backend.

Repeat it from the repository root:

```powershell
cargo build --manifest-path src-tauri/Cargo.toml -p faro-cli
src-tauri/target/s3-lab-venv/Scripts/python.exe scripts/audit-s3-cli.py
```

The script starts and stops its own Moto server on a free loopback port,
creates dummy profiles under a temporary `FARO_DATA_DIR`, and checks actual S3
keys and local bytes. It also uses a separate deterministic HTTP 403 fixture
to test an unreadable S3 source. It never reads the user's saved profiles or
connects to a real bucket. Exit 1 means expectations failed; evidence is saved
to `src-tauri/target/s3-cli-audit.json` (git-ignored). Temporary test files and
both servers are cleaned up automatically.

### Verified working in the CLI

- Saved-profile loading and marker-aware directory listing.
- Paginated listing of 1,005 objects.
- Ordinary file upload/download, zero-byte files, spaces and ampersands.
- A 17 MiB multipart upload and download, with byte equality checked.
- Ordinary file rename and delete.
- Recursive deletion of an implicit prefix, preserving a similarly named
  neighboring prefix (`delete/` versus `delete-other/`).
- Sync dry-run without writes, nested push/pull, successful mirror deletion
  in both directions, and pulling files from marker-backed directories.
- Hash diff for ordinary keys: identical trees and different equal-size files.
- Name search, opted-in content search, and hash-based duplicate detection.
- Nonzero errors for missing downloads, a denied individual deletion, and an
  explicitly denied directory listing.
- Clear rejection of SSH `exec`, remote-to-remote `cp`, and `cp --recursive`.

### Historical findings and implemented fixes

| Priority | Finding | Reproduction and consequence | Code |
| --- | --- | --- | --- |
| 1 | Mirror sync must reject incomplete or unreadable sources | A 403 while listing the S3 source was treated as an empty tree. Pull with `--mirror` deleted a local `keep.txt` and exited 0. A nonexistent local source likewise caused push with `--mirror` to delete the remote `keep.txt`. | `src-tauri/src/scan.rs` (`walk_tree`, discarded listing errors), `src-tauri/src/sync.rs` (`plan_indexed`) |
| 1 | Exact object identity must survive deletion | `rm lab:/collision/ --recursive` deleted the separate object `collision` and left `collision/child.txt`. Deleting `whitespace/report.txt ` (trailing space) deleted `whitespace/report.txt` instead. | `src-tauri/src/remotefs/object.rs` (`normalize_prefix`, `delete`) |
| 2 | Key encoding must preserve stored names | Downloads of `café.txt`, `100%.txt`, and `hash#.txt` failed. Uploading `café.txt` created the literal key `caf%C3%A9.txt`. Listing a Unicode prefix returned an empty successful result. | `Path::from` calls throughout object-backed operations, including CLI upload/download |
| 2 | Failure must affect CLI exit status | `diff --hash` compared `AAA` with `BBB` under a Unicode key, recorded `hashError`, still classified it as `same`, and exited 0. Mirror sync whose deletion returned 403 printed a warning followed by `Sync complete.` and exited 0. | `src-tauri/src/diff.rs` (`hash_pass`), `src-tauri/faro-cli/src/main.rs` (`cmd_diff`, `cmd_sync`) |
| 2 | `cp` must honor the destination filename | Uploading `small.txt` to `rename-copy/different.txt` created `rename-copy/small.txt`. Downloading to `download-renamed.txt` created a directory of that name containing `small.txt`. Both exited 0. These argument-handling problems are not specific to S3. | `src-tauri/faro-cli/src/main.rs` (`cmd_cp`, `download_file`) |
| 3 | Directory-marker handling must extend beyond browsing | Recursive removal left `delete-marked/` and `delete-marked/empty/`. Name search reported a folder marker as `isDir: false`. | `src-tauri/src/remotefs/object.rs` (`delete`), `src-tauri/src/search.rs` (`name_object`) |
| 3 | Directory feature support needs an explicit contract | Prefix rename failed with 404. `mkdir` intentionally returned success without creating anything. Sync copied the files but omitted an empty marker-backed directory. | Object adapter `rename`/`create_dir`; file-only sync plan |

Every finding in the table is now covered by passing regression checks. The
shared scanner rejects missing/unreadable source roots and child-listing errors;
only a missing destination root can be treated as empty. Exact-key operations
preserve trailing spaces and distinguish files from directory prefixes.

Sync plans now include empty directories, and the app sync dialog displays
them. The shared app/Bridge executor propagates deletion errors and waits for
successful copies before applying mirror deletions. CLI mirror deletion and
hash-read failures return nonzero status. Explicit `cp` destination filenames
are honored; use a trailing slash for a remote destination directory. For local
destinations, an existing directory or trailing separator means a directory;
otherwise the argument is the destination filename.

Reported CLI download failures clean up a staged file without touching the
original destination. A complete download is synced and atomically placed.
Multipart upload errors and Ctrl+C request an abort, and abort failures are
reported. The fault suite verifies truncated downloads, multipart abort after
a rejected part, unreadable child directories, and denied hash reads.

### Parity and remaining validation

CLI `cp` remains file-only; use `sync` for directory trees. Remote-to-remote
`cp` and SSH `exec` on S3 are explicitly rejected. CLI transfers remain separate
from the app's transfer manager: persistent CLI pause/resume and parallel-range
scheduling have not been added. Abrupt process termination or loss of network
access during cleanup can still leave temporary files or multipart uploads.

S3 directory rename consists of copies followed by deletions, not an atomic
transaction. Existing destination prefixes and overlapping source/destination
prefixes are rejected; all copies must succeed before source deletion starts.
Concurrent changes and versioned-bucket behavior need provider-specific tests.

Still untested: actual Wasabi and other vendors, real IAM/credential discovery
and session tokens, TLS, object locks, encryption/KMS, throttling, and exhaustive
GUI/Agent Bridge/editor/preview workflows. The frontend type-checks and the app
transfer runner is exercised directly; no full native GUI end-to-end test was
performed. Moto success is evidence for tested semantics, not certification of
every provider or bucket configuration.

# Plan 25 — WordPress backend (the whole site over HTTPS, with wp-cli-style commands)

## Context

Same proven recipe as Plans 5/18/20/21: one `RemoteFs` impl, one `Session`
variant, transfer/editor arms, New-Connection UI. This plan adds
**WordPress** — and it targets the exact gap the Shopify/HubSpot/Dynamics
backends don't cover: a *self-hosted* site where you are a full admin but the
host gives you **FTP only, or nothing but wp-admin**. No SSH, so no shell, no
WP-CLI, no `mysql`. That is most shared hosting, and most agency client sites.

The Plan 10 workflow (diagnose via the DB, run WP-CLI, clear caches) works
great on a box Faro can SSH into. On FTP-only hosts it falls apart: you can
move files, but you can't flush a cache, toggle a plugin that white-screens the
site, read an option, or run a search-replace. Today people do this with a
throwaway `fix.php` uploaded over FTP, or a file-manager plugin in wp-admin.

The insight: **an admin login is already code execution on the site** — an
admin can install plugins. So a tiny Faro-owned companion plugin, authenticated
with core's **Application Passwords**, can give Faro:

- **the whole WordPress tree as a real filesystem over HTTPS** (rooted at
  `ABSPATH`) — browse, transfer, diff, folder sync, in-place edit — with no
  FTP/SSH at all; and
- **a curated, wp-cli-shaped command surface** (cache/rewrite flush, plugin
  toggle, options, cron, search-replace, DB export, debug log) without a shell.

Why it's worth a backend slot:

- **The FTP-only host is the common case**, and the incumbent tools (FTP +
  hand-rolled PHP, WP File Manager-style plugins) are clunky and unsafe.
- **Agency workflow.** Dozens of client sites, each already a saved Faro
  connection (usually FTP). Adding "WordPress" to one gives commands on hosts
  that never had them.
- **Agent Bridge synergy.** "This site white-screens after an update — find
  the plugin and disable it" is a perfect approved-agent task, and today it is
  impossible on an FTP-only host.
- **It rides existing machinery.** Browse, transfer queue (ranged downloads,
  resume), diff, sync, editor, previews — all inherited from the trait.

Scope honesty: this is not a shell. Commands are a fixed, typed set (no `exec`
— many hosts disable it anyway). Everything runs inside a PHP web request, so
it inherits `max_execution_time`, `memory_limit` and `post_max_size`, and a WAF
can get in the way. All declared up front via the handshake and `Capabilities`.

**Hosts with SSH need none of this.** Where the host offers SSH (e.g. WP
Engine's SSH Gateway: add a key in the User Portal, then an SSH profile for
`{install}@{install}.ssh.wpengine.net`), a plain Faro SSH profile already
gives real WP-CLI today. This plan is for every site without that.

**Order: REST first, plugin second.** WordPress's REST API, with an
Application Password, already reaches most of what a site exposes: core
posts/pages/users/plugins/settings, plus any plugin that registers routes
(Gravity Forms `gf/v2`, WooCommerce `wc/v3`, Yoast, ACF…). That needs no
plugin and adds no attack surface, so it ships first (Phase 1). The connector
plugin fills the gaps REST doesn't cover (files, caches, DB, plugin settings
with no endpoint, Elementor data) and comes after.

Worked example (the motivating task): change who a Gravity Forms notification
goes to, and check the HubSpot feed, on an FTP-only site:

```
faro-cli wp <site> rest GET /gf/v2/forms/1 > form.json        # read notifications
# edit notifications[].to in form.json
faro-cli wp <site> rest PUT /gf/v2/forms/1 --data @form.json  # save (approval in Faro)
faro-cli wp <site> rest GET "/gf/v2/feeds?addon=gravityformshubspot"
```

…or in the GUI: open `/rest/gf/v2/forms/1.json` on the connection, edit it in
place, save — the save is the `PUT`.

---

## Two tiers

| Tier | Needs | What Faro gets |
|------|-------|----------------|
| **REST** (no plugin) | Admin user + Application Password | Any REST route on the site, core or plugin (`rest` passthrough + editable JSON resources), media library as files, plugin toggle. Ships first. |
| **Connector** (Faro Connector plugin) | Same, plus the plugin installed | Full `ABSPATH` filesystem + the command surface + DB. Covers what REST can't. |

The REST tier is useful on its own (most edits, e.g. Gravity Forms, need
nothing more) and lets the "install connector" step happen *from inside Faro*.

---

## API surface (what we're mapping)

### Core REST (`{site}/wp-json/wp/v2/`, Basic auth with an Application Password)

- `GET /wp-json/` — discovery; confirms REST is on and returns
  `authentication.application-passwords` (the authorize endpoint URL).
- `GET /users/me?context=edit` — connect-time probe; must have
  `capabilities.manage_options` (and `manage_network` on multisite).
- `GET/POST/DELETE /media` — media library (`source_url`, `media_details`,
  `date`, `mime_type`). Upload = raw body + `Content-Disposition`.
- `GET /plugins`, `GET /themes` — listing; `POST /plugins/{plugin}` with
  `status` toggles activation (the "rescue a white screen" op works even in
  REST tier).
- `POST /plugins {slug, status:"active"}` — install from wordpress.org.
  This is the zero-FTP install route for the connector once it is listed
  (Phase 2).
- **Any other namespace** — `GET /wp-json/` lists every registered
  namespace and route (`gf/v2`, `wc/v3`, `yoast/v1`, `acf/v3`…). Faro does
  not model these; it passes them through (`rest` command) and exposes the
  ones that look like resources as editable JSON files (see Path mapping).

What REST does *not* reach: page-builder content stored in post meta
(Elementor `_elementor_data` is not REST-exposed by default), raw DB, files,
caches, and plugin settings with no route. That is the connector's job.

### Faro Connector (`{site}/wp-json/faro/v1/`)

A single-file plugin (`faro-connector.php`, no dependencies, PHP ≥ 7.4) that
registers a REST namespace. Every route checks
`current_user_can('manage_options')` (network admin on multisite).

- `GET /hello` — handshake: connector version + `proto` (integer, additive
  ops only — same rule as the agent protocol), WP/PHP versions, `ABSPATH`,
  `is_multisite`, `DISALLOW_FILE_MODS`, `disable_functions`, limits
  (`upload_max_filesize`, `post_max_size`, `max_execution_time`,
  `memory_limit`), and which optional ops are enabled.
- **Filesystem** (paths relative to `ABSPATH`, jailed — see Security):
  - `GET /fs/list?path=` → `[{name, type, size, mtime, mode, link}]`
  - `GET /fs/stat?path=`
  - `GET /fs/read?path=` — streamed with `fpassthru`, honors `Range`
    (lets Plan 24's ranged-download engine and resume work unchanged).
  - `PUT /fs/write?path=&offset=&final=` — raw body chunk, appended at
    `offset` into `{path}.faro-part`; `final=1` renames into place
    (atomic finalize, matches Plan 24). Chunk size = min(8 MiB,
    `post_max_size` − slack) from the handshake.
  - `POST /fs/rename`, `POST /fs/delete {path, recursive}`,
    `POST /fs/mkdir`, `POST /fs/chmod {path, mode}`.
- **Commands** (`POST /cmd/{op}`, JSON in/out) — the wp-cli-shaped set:
  | op | wp-cli equivalent |
  |----|-------------------|
  | `cache.flush` | `wp cache flush` (+ known page-cache plugins' purge hooks) |
  | `rewrite.flush` | `wp rewrite flush` |
  | `transient.delete {all\|expired\|name}` | `wp transient delete` |
  | `option.get/update/delete` | `wp option …` (update requires approval-class op) |
  | `plugin.list/activate/deactivate/update` | `wp plugin …` |
  | `theme.list/activate` | `wp theme …` |
  | `core.version/check-update` | `wp core version / check-update` |
  | `cron.list/run {hook}` | `wp cron event list/run` |
  | `user.list` | `wp user list` (no passwords, ever) |
  | `maintenance.on/off` | `wp maintenance-mode` (writes/removes `.maintenance`) |
  | `debug.tail {lines}` | tail of `WP_DEBUG_LOG` |
  | `db.query {sql}` | `wp db query` — **read-only**: single statement, must parse as `SELECT/SHOW/DESCRIBE/EXPLAIN`, run in a read-only transaction, row cap |
  | `db.export` | `wp db export` — streamed SQL dump (chunked by table/row range so it survives `max_execution_time`) |
  | `search-replace {from,to,dry_run}` | `wp search-replace` — serialization-safe, **dry run by default** |
  | `site.health` | Site Health tests summary |
- **Optional, off by default**: `POST /cmd/eval {php}` (`wp eval`). Only
  exists when `define('FARO_ALLOW_EVAL', true)` is in `wp-config.php`, so
  enabling it requires file access the admin already has — the plugin alone
  never grants it.

### Constraints to design around

- **Authorization header stripping.** Many CGI/FastCGI hosts drop
  `Authorization`. Core already reads `REDIRECT_HTTP_AUTHORIZATION`; the
  connector additionally accepts `X-Faro-Authorization` and maps it before
  auth runs. Faro sends both on connector routes and reports which one worked.
- **Application Passwords disabled.** Some security plugins turn them off, and
  core requires HTTPS outside `WP_ENVIRONMENT_TYPE=local`. Fallback: the
  connector's settings page issues its own **Faro key** (random 32 bytes,
  stored hashed in an option, scoped to one admin user), sent as
  `X-Faro-Key`. Connect error copy names the exact cause.
- **WAFs** (ModSecurity, Wordfence, Cloudflare) can flag PHP/SQL in request
  bodies. Uploads are raw `application/octet-stream`, not form posts; on a
  403 with a WAF signature, Faro retries the chunk base64-wrapped once and
  surfaces "your firewall blocked this upload" if that fails too.
- **Time and memory limits.** Everything long is chunked: uploads, ranged
  reads, recursive delete (server deletes up to N entries per call and returns
  `more:true`), DB export, search-replace (per-table batches with a cursor).
- **Caching layers.** `/wp-json/faro/*` responses send `Cache-Control:
  no-store` and the connector excludes itself from common page caches.
- **No REST at all** (`/wp-json` blocked): connector also answers on
  `?rest_route=/faro/v1/…`; Faro tries the pretty URL, then that.

---

## Security model

- **Capability gate** on every route; the connector refuses to load on
  `DISALLOW_FILE_MODS` sites for write ops (reports read-only in `/hello`).
- **Path jail**: resolve with `realpath` (or the parent's, for new files)
  and require the prefix `ABSPATH`; reject `..`, NUL, and symlinks that
  escape. Optional `FARO_ROOT` constant narrows it (e.g. to `wp-content`).
- **Guarded files**: writing `wp-config.php` or `.htaccess` needs an explicit
  `confirm:true` in the request; Faro shows a confirm dialog. Reads are
  allowed (admin can already see DB credentials via other means; we don't
  pretend otherwise), but the Agent Bridge treats them as approval-class.
- **No secrets in transit beyond auth**: `user.list` never returns hashes;
  `option.get` redacts known secret options unless `reveal:true`.
- **Audit**: every write/command appends to a capped `faro_log` option
  (time, user, op, path) shown on the connector's settings page.
- Faro side: the Application Password / Faro key lives in the **OS keychain**
  (`credentials.rs`, `wordpress:{profile_id}`), never in `profiles.json`,
  never across IPC after `set`.

---

## Connecting — the easy path

The user asked for "an easy way to connect if we have the whole access".
Three entry points, all landing in the same profile:

1. **"Sign in with WordPress" (preferred).** Faro asks only for the site URL,
   reads the authorize endpoint from `/wp-json/`, and opens
   `/wp-admin/authorize-application.php?app_name=Faro&app_id={uuid}&success_url=faro://wp-auth?state={nonce}`
   in the system browser. The admin logs in (2FA and all, handled by WP),
   clicks Approve, and WordPress redirects to the `faro://` deep link with
   `user_login` + `password`. `deeplink.rs` gets a `wp-auth` action that
   matches `state` to a pending request (single-use, 10-minute TTL), stores
   the password straight into the keychain, and finishes the connect. No
   copy-pasting passwords. (Core rejects only `http` success URLs off local
   envs; a custom scheme is allowed.)
2. **Manual**: site URL + username + pasted Application Password (or Faro
   key). For when the deep link can't come back (locked-down browsers).
3. **From an existing FTP/SFTP connection**: right-click a saved connection →
   *Add WordPress access…* Faro detects `wp-config.php` under the connection's
   path, reads `siteurl` hint from it if obvious, and pre-fills the URL.

Then **installing the connector** (Phase 2), whichever applies:

- **Have FTP/SFTP to the same site** → Faro uploads the bundled
  `faro-connector.php` to `wp-content/mu-plugins/` over that connection
  (must-use: no activation step, survives "deactivate all plugins").
- **wp.org listing exists and file mods allowed** → `POST /wp/v2/plugins
  {slug:"faro-connector",status:"active"}` — one click, no FTP.
- **Neither** → Faro saves `faro-connector.zip` and shows the two-step
  "Plugins → Add New → Upload" instruction, then polls `/hello`.

---

## Path mapping

Connector tier:

```
/                         → ABSPATH (the WordPress root)
/wp-content/themes/…      → real files
/wp-config.php            → real file (guarded write)
```

REST tier (no connector; under `/.rest/` and `/.media/` once the connector is in):

```
/                         → virtual: media/  rest/   (banner: "Install Faro Connector for full access")
/media/2026/10/photo.jpg  → attachment, path from its upload subdir + filename
/rest/gf/v2/forms/        → GET /gf/v2/forms, one entry per item
/rest/gf/v2/forms/1.json  → GET /gf/v2/forms/1 (pretty JSON); write = PUT
```

- `rest/` is built from the discovery index: namespaces → routes. A route
  becomes a directory when its GET returns an array of objects with an `id`;
  each item is `{id}.json`. Writing a file `PUT`s it back (falls back to
  `POST` when the route only accepts that); deleting it `DELETE`s it. Routes
  that don't fit the pattern are left to the `rest` command.
- Edits are whole-resource round-trips: Faro re-`GET`s before save and
  refuses if it changed since open (body hash), so a stale editor can't
  clobber someone else's change.

- Connector `DirEntry` carries `size`, `mtime`, `mode` →
  `change_signal: ChangeSignal::MtimeSize`.
- **Capabilities** (connector): `can_chmod: true, can_symlink: false,
  can_rename: true, has_directories: true, has_shell: false`. New field
  **`has_commands: bool`** — true here; gates the WordPress command palette
  and the Agent Bridge `wp` tool. (False for every existing backend; SSH keeps
  `has_shell`.)
- REST tier: `can_chmod: false, can_rename: false` (media can't be moved),
  `has_commands: true` with only `rest` + plugin activate/deactivate.

---

## Phases

### Phase 1 — WordPress REST profile (no plugin)

The smallest useful slice; makes the Gravity Forms example work.

1. **`faro-cli fetch` sends changes, not just reads.** Add
   `--method GET|POST|PUT|PATCH|DELETE` (default GET), `--data @file|-|<json>`
   and repeatable `--header`. Body defaults to `Content-Type:
   application/json` when it parses as JSON. Today `cmd_fetch`
   (`faro-cli/src/main.rs`) hard-codes `Method::GET`; it already reuses an
   HTTP profile's stored Basic Auth, which is exactly what an Application
   Password is. Also accept `wordpress` profiles in its host matching.
2. **`wordpress` profile type.** Site URL, username, Application Password
   (keychain, `wordpress:{profile_id}`). On save, Faro checks
   `GET /wp-json/wp/v2/users/me?context=edit` and reports the exact failure:
   bad password, Application Passwords disabled (Wordfence and similar have a
   switch for this), not an admin, REST blocked.
   - NEW `session/wordpress.rs` — `WordPressSession` on the
     `session/shopify.rs` shape: shared `reqwest::Client`,
     `env_or("FARO_WP_…")` override for tests, one `send()` with the
     auth-header fallback + 429/5xx backoff (`http_throttle.rs`), REST vs
     `?rest_route=` URL builder decided at connect, cached discovery index.
     `account_label()` → `user@host`.
   - NEW `remotefs/wordpress.rs` — `WordPressFs` REST tier: `media/` and
     `rest/` as in Path mapping.
   - `remotefs/mod.rs` — `has_commands` on `Capabilities` (default false;
     the compiler finds every literal).
   - `session/mod.rs` — `Session::WordPress` + arms (`protocol()` →
     `"wordpress"`); `fs_for*` factory arms in `commands.rs`, `transfer.rs`,
     `faro-cli`; `editor.rs` read/write arms (this is what makes
     `rest/gf/v2/forms/1.json` editable in place).
   - Frontend: `"wordpress"` in `types.ts`, brand icon
     (`simple-icons:wordpress`, add to `CURATED`, regen), `WordPressSection`
     in `ProfileEditor` (manual fields for now), "Websites" picker group,
     `ServerRail` label, deep-link `known` protocols.
3. **Agent Bridge `wp_rest` tool** / `POST /sessions/{id}/wp/rest`
   `{method, path, body}` through `gate()` with the exec rule: `GET`/`HEAD`
   run without a prompt under `auto_safe_exec`; `POST/PUT/PATCH/DELETE`
   always ask for approval in Faro, showing method, route and a body
   preview. `exec_on`'s "can't run commands" error points WordPress
   connections here.
4. **`faro-cli wp <connection> …` helpers** over REST so agents and people
   don't hand-build requests: `rest <METHOD> <route> [--data]`,
   `plugins [activate|deactivate <slug>]`, `options` (`/wp/v2/settings`),
   `forms [<id>]` (only when `gf/v2` is registered), `routes` (prints the
   discovery index — "what can I reach on this site?").

**Tests:** Docker WordPress (`wordpress:php8.3-apache` + `mariadb`,
`WP_ENVIRONMENT_TYPE=local`) with a tiny test plugin that registers a
`faro-test/v1/items` CRUD route standing in for Gravity Forms.
`live_wordpress_rest` (`#[ignore]`, env-gated on `FARO_WP_TEST_URL`): connect
→ users/me check → list `rest/` → edit an item via the fs path → `PUT` lands →
stale-edit refusal → plugin deactivate/activate. Unit tests for `fetch`
argument parsing and the route→directory heuristic.

**Done when:** in the GUI, open a JSON resource on the Docker site, edit it,
save, and see the change via a fresh GET; and the same edit through
`faro-cli wp … rest PUT` and through the bridge (with its approval prompt).

### Phase 2 — Easy sign-in & connector install

- `deeplink.rs` — `wp-auth` action; pending-state map in the session manager
  (nonce, TTL, single use); writes the password to the keychain directly.
- `ProfileEditor` — "Sign in with WordPress" button (primary), manual fields
  behind "Enter an application password instead".
- *Add WordPress access…* context-menu entry on FTP/SFTP connections.
- Connector install flows: FTP/SFTP drop-in to `mu-plugins` (picks a saved
  connection whose tree contains `wp-config.php`; asks which if several),
  wp.org install via REST, zip export fallback.
- Submit the plugin to the wordpress.org directory (maintainer action — the
  account is theirs). Until listed, the REST install route is hidden.

### Phase 3 — Connector plugin + full filesystem

**Plugin (new package):**

- NEW `packages/wp-faro-connector/faro-connector.php` — the whole plugin,
  one file: `/hello`, the `fs/*` routes, auth-header fallback, path jail,
  guarded files, audit log, settings page (Faro key, log, "allowed root").
- NEW `packages/wp-faro-connector/readme.txt` — wp.org-format readme (for
  Phase 2's listing).
- The PHP file is embedded in the Faro binary (`include_str!`) so the FTP
  drop-in install needs no network.

**Rust:**

1. `session/wordpress.rs` — connect also probes `/hello`; when present the
   tier flips to connector and the limits are cached.
2. `remotefs/wordpress.rs` — connector arms: `/` = `ABSPATH`, REST tier moves
   under `/.rest/` and `/.media/`; `rename`, `delete` (loops on `more:true`),
   `create_dir`, `chmod`. Unit tests: jail-relative mapping, `/hello`
   parsing, chunk sizing from limits.
3. `transfer.rs` — download via `fs/read` on the Plan 24 ranged engine
   (Range supported ⇒ parallel + resume for free); upload via chunked
   `fs/write` with `offset` resume.
4. `preview.rs`, `search.rs` arms (same list as Plan 18).

**Frontend:** file-pane banner while in REST tier; nothing else new.

**Tests:** run **real WordPress** in Docker (`wordpress:php8.3-apache` +
`mariadb`, `WP_ENVIRONMENT_TYPE=local` so Application Passwords work over
http), connector mounted into `mu-plugins`. `live_wordpress_roundtrip`
(`#[ignore]`, env-gated on `FARO_WP_TEST_URL`): connect → list `/` →
upload 20 MiB (multi-chunk) → ranged read back + hash → rename → chmod →
recursive delete. Plus a PHPUnit-free PHP smoke script for the jail
(`../`, symlink escape, NUL) run with `php -f` in the container.

**Done when:** browse a Docker WordPress in the GUI with no FTP configured,
edit `wp-content/themes/…/style.css` in place, drag a folder in, see it land.

### Phase 4 — Commands without a shell

- Connector: the `cmd/*` routes from the table above (minus DB, Phase 4).
- `session/wordpress.rs` — typed `run_command(op, args)`.
- **Command palette** on WordPress connections (gated by `has_commands`):
  the common ops as buttons (Flush caches, Flush permalinks, Maintenance
  on/off, Tail debug log) plus a **`wp>` console** in the Terminal tab that
  parses a wp-cli-shaped subset (`wp plugin deactivate woocommerce`,
  `wp option get siteurl`) into ops and prints wp-cli-like tables. Unknown
  commands say so and list what is supported — no pretending it's a shell.
- **Agent Bridge**: `wp` tool / `POST /sessions/{id}/wp` beside Phase 1's `wp_rest`,
  through `gate()`. Read ops (`*.list`, `option.get`, `debug.tail`,
  `core.version`) are auto-safe under the existing `auto_safe_exec` policy;
  everything else prompts.
- **faro-cli**: `faro-cli wp <connection> <args…>` gains these ops — same
  parser as the console; `--json` output.

### Phase 5 — Database

- `db.query` (read-only, row-capped) in console/CLI/bridge.
- `db.export` → streamed `.sql` download through the transfer queue (shows
  progress, resumable by table cursor).
- `search-replace` with dry run by default; the GUI shows the per-table
  counts from the dry run and needs a second click to apply. Recommend (not
  force) a `db.export` first.
- `eval` wiring, only when `/hello` reports `FARO_ALLOW_EVAL`.

---

## Non-goals (v1)

- **No real shell / WP-CLI** — not possible from a web request on these hosts,
  and `exec` is usually disabled. The command set is curated on purpose.
- **No DB writes beyond search-replace and options** — no arbitrary
  `UPDATE/DELETE`. A bad query on a client's production DB with no shell to
  recover from is the worst case this plan exists to avoid.
- **No friendly content editing** (posts/pages as Markdown) — posts are
  reachable as raw JSON under `rest/wp/v2/`; a nicer mapping is later work,
  same caveats as Shopify Phase 3.
- **No multisite network-wide fan-out** — one site per connection; network
  admins get the network's `ABSPATH` and per-site ops take a `url` arg later.
- **No auto-update of the connector** — v1 shows "connector outdated" from
  `/hello` and offers the same install flow to replace it.

## Docs & counts on ship

README backend count + feature line, ROADMAP row, `docs/deep-links.md` (the
`wp-auth` action and `protocol=wordpress`), a phase note in
`docs/plans/5_additional-backends.md`, and `packages/wp-faro-connector/readme.txt`.

# Plan 25 — WordPress backend (the REST API as a connection)

## Context

Faro already reaches a WordPress site's *files* over SFTP/FTP. What it couldn't
reach is the site's *data* when there is no shell: a Gravity Forms notification
recipient, a setting, a post, a plugin that white-screens the site. On hosts
with SSH (e.g. WP Engine's SSH Gateway — add a key in the User Portal, then an
SSH profile for `{install}@{install}.ssh.wpengine.net`) a plain Faro SSH profile
already gives real WP-CLI. This plan is for every site without that.

WordPress has shipped **Application Passwords** since 5.6: per-app Basic Auth
logins an admin can revoke without touching their real password. With one,
the REST API reaches core (posts, pages, users, settings, plugins, media) and
**every plugin that registers routes** — Gravity Forms `gf/v2`, WooCommerce
`wc/v3`, Yoast, ACF. No plugin to install, no attack surface added. That is
the whole backend.

Motivating task — change who a Gravity Forms notification goes to and check
the HubSpot feed, on an FTP-only site:

```
faro-cli wp <site> rest GET gf/v2/forms/1 > form.json        # read notifications
# edit notifications[].to in form.json
faro-cli wp <site> rest PUT gf/v2/forms/1 -d @form.json      # save
faro-cli wp <site> rest GET "gf/v2/feeds?addon=gravityformshubspot"
```

…or in the GUI: open `rest/gf/v2/forms/1.json` on the connection, edit it in
place, save — the save is the `PUT`. Through the Agent Bridge the same edit is
a `faro_wp_rest` call that the user approves in Faro.

Scope honesty: the REST API covers only what core and plugins expose.
Page-builder data (Elementor's `_elementor_data`), raw DB access, files,
caches and plugin settings without a route are out of reach — SSH/WP-CLI (or
FTP for files) is still the answer there.

---

## What shipped — ✅ built + runtime-verified

### Connection

- **Profile** (`protocol: "wordpress"`): `endpoint` = the full site URL
  (scheme + subdirectory installs), `host` = its hostname, `port` = its port,
  `username` = the WordPress login. The Application Password lives in the OS
  keychain as `wordpress:{profile_id}` (never `profiles.json`); spaces in the
  pasted password are stripped (WordPress ignores them).
- **Connect** (`session/wordpress.rs`): `site_base()` normalizes what was typed
  (adds `https://`, drops a pasted `/wp-admin…`/`/wp-json…`), the public
  discovery index is fetched from `/wp-json/` and, when that 404s (plain
  permalinks, or `/wp-json` blocked), from `/?rest_route=/` — the style sticks
  for the session. Then `GET /wp/v2/users/me?context=edit` must show
  `manage_options`. Failures are named: wrong password, Application Passwords
  disabled (Wordfence's switch, or a non-HTTPS non-local site), the host
  stripping `Authorization` (with the Apache `SetEnvIf` fix), not an admin,
  REST blocked.
- **Pacing**: the shared `http_throttle` (50 ms spacing, 429 `Retry-After`,
  5xx backoff) — small shared hosts and security plugins dislike bursts.
- **Capabilities**: no chmod/symlink/rename, directories yes, `has_shell:
  false`, new **`has_commands: true`** (added to `Capabilities`, default false
  on every other backend), `change_signal: MtimeSize`.

### Filesystem mapping (`remotefs/wordpress.rs`)

```
/                         → media/  rest/
/media/2026/10/photo.jpg  → attachment (path = its file under uploads/)
/rest/                    → namespaces, split on "/" (wp/ → v2/, gf/ → v2/ …)
/rest/gf/v2/forms/        → collection: GET /gf/v2/forms, one {id}.json per item
/rest/gf/v2/forms/1.json  → GET /gf/v2/forms/1 (pretty JSON); save = PUT
/rest/wp/v2/settings.json → single resource: GET /wp/v2/settings; save = PUT
```

- A route `/{ns}/{name}` with a sibling `/{ns}/{name}/(?P<…>)` is a
  **collection**; a GET-able `/{ns}/{name}` without one is a **single**
  `{name}.json`. Deeper routes are left to `wp rest`. Collections page 100 at
  a time (`X-WP-TotalPages`, capped) and accept both array responses and Gravity
  Forms' object-keyed-by-id shape. Core routes are read with `context=edit`.
- **Saving** refuses invalid JSON, and refuses when the resource changed on the
  site since it was opened (the opened version is kept and compared before the
  write). Plugin routes get the whole object (Gravity Forms `PUT` replaces the
  form); **core `wp/v2` routes get only the edited top-level fields** with
  `{raw, rendered}` pairs flattened to `raw` — sending back untouched
  read-only/null fields is rejected by core (found live: `site_logo: null` on
  `/wp/v2/settings`). `PUT` falls back to `POST` when a route has no `PUT`.
- A **new name** in a collection (`new.json`) is a `POST` to the collection;
  **delete** is a `DELETE` on the item.
- **Media**: upload is `POST /wp/v2/media` (WordPress picks the year/month
  folder; replacing an existing file is refused with the attachment id),
  download is the public `source_url`, delete is `?force=true`. No rename/mkdir.
- Transfer, editor (in-place edit), preview and content-search arms all use
  `read_file`/`write_file` (whole-body; sizes are advisory).

### CLI

- **`faro-cli fetch`** gains `-X/--method` (GET, HEAD, POST, PUT, PATCH,
  DELETE), `-d/--data` (`@file`, `-` for stdin, or literal; JSON bodies get
  `Content-Type: application/json`) and repeatable `-H/--header`. It also
  matches **WordPress** profiles by host, not just HTTP(S) ones.
- **`faro-cli wp <connection> …`**: `rest <METHOD> <route> [-d …]` (prints
  pretty JSON, exits 1 on non-2xx), `routes [filter]`, `plugins
  [activate|deactivate <slug>]`, `options [name]` (`/wp/v2/settings`),
  `forms [id]` (only when `gf/v2` exists). Routes may omit the leading `/`;
  a drive-prefixed route (Git Bash's MSYS rewrite of `/gf/v2/…`) is refused
  with the fix.

### Agent Bridge

- **`faro_wp_rest`** MCP tool / `POST /wp_rest` `{sessionId, method, route,
  body}`. `GET`/`HEAD` are reads (auto-approved when "auto-approve reads" is
  on); every other method is a write that always prompts, and the approval
  modal shows the method, route and a body preview. Returns `{status, body}`.
  `faro_exec`'s "can't run commands" error points WordPress connections here.

### UI

- **New Connection → Web → WordPress**: site address, a **"Create an
  application password"** button, username + application password fields
  (no "generate password" — WordPress issues it), keychain/Wordfence hints.
  The button opens the site's own `wp-admin/authorize-application.php` with
  `app_name=Faro` and a fixed `app_id`, found via discovery; the admin
  approves and WordPress shows the password on that page to paste. A "copy the
  link" fallback appears if no browser opened.
- Rail label `user@site`, WordPress brand icon, deep-link prefill
  (`faro://connect?protocol=wordpress&…`).

### Why not a one-click "Sign in with WordPress"

The authorize page *can* redirect the new password to a `success_url`, but
WordPress escapes that URL with `esc_url()`, which blanks any scheme outside
its allow-list — so a `faro://` callback is silently dropped, and a plain-http
loopback is refused on non-local sites. Verified against WordPress 6.7. The
paste step is the honest flow without a server Faro would have to host.

---

## Verification

- **Unit**: URL normalization, REST URL styles, discovery parsing, item
  extraction (array + keyed object), raw-field flattening, changed-field diff,
  plugin slug resolution, GMT time parsing, path ↔ route resolution, media tree
  (`cargo test -p faro --lib wordpress`); CLI route guard (`-p faro-cli`).
- **Live** against real WordPress 6.7 in Docker
  (`src-tauri/tests/wordpress/setup.sh`, plain permalinks so the
  `?rest_route=` fallback is exercised): `live_wordpress_rest` — discovery →
  dirs, edit a plugin-collection item in place, stale-save refusal, invalid
  JSON refused, create + delete an item, edit `/wp/v2/settings` and a post's
  raw title, media upload → list → byte-identical read → delete, plugin
  activate/deactivate, non-2xx passthrough, authorize-page discovery.
- **CLI** against the same site: `wp routes/rest/options/plugins/forms`,
  `fetch` GET and POST, non-2xx exit code, MSYS route guard.
- **Real app** (`scripts/verify-wordpress.mjs`, dev build with an alt
  identifier beside the installed Faro, over WebView2 DevTools): connect,
  capabilities, root + collection listing, bridge GET, bridge PUT raising the
  approval modal and landing after approval, the editor's WordPress section,
  filling the form and Save storing endpoint/host/port + keychain secret, the
  saved connection connecting, rail bubble → Connect → file pane listing.

---

## Not built

- **A companion plugin** (full `ABSPATH` filesystem over HTTPS, cache flush,
  cron, maintenance mode, DB export/search-replace) — dropped from this plan;
  REST plus SSH/FTP cover the motivating cases.
- **Friendly content editing** (posts as Markdown) — posts are raw JSON under
  `rest/wp/v2/posts/` today.
- **Nested routes as paths** (`gf/v2/forms/1/entries`) — use `wp rest`.
- **Multisite network fan-out** — one site per connection.

## Docs & counts on ship

README backend table/counts, `docs/deep-links.md` (`protocol=wordpress`), a
phase note in `5_additional-backends.md`, and the ROADMAP row.

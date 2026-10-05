# Faro deep links (`faro://`)

Faro registers the `faro://` URL scheme, so a web page, an email, or a hosting
panel like **ServerKit** can offer a one-click **"Open in Faro"** / **"Connect
with Faro"** button next to a site. Clicking it opens Faro (launching or
focusing it) with the **New Connection editor prefilled** — think of it as a
magnet link for a server.

## Security model — read this first

A registered protocol handler can be invoked by *any* web page, so a Faro deep
link is treated as **untrusted input**:

- **A link never connects on its own.** It only ever *prefills* the connection
  editor. The user sees exactly what they're about to connect to and clicks
  **Connect** (or **Pair**) themselves.
- **A link never carries a password, secret, or passphrase.** Those parameters
  are ignored (and logged as a warning) if present. Credentials are entered in
  Faro or come from the OS keychain — never from a URL that could sit in a
  browser history, a chat log, or a server access log.
- Unknown actions and unparseable links are dropped silently.

So the worst a hostile link can do is pop open a connection form pointed at a
host of the attacker's choosing — which the user still has to act on.

## Grammar

```
faro://<action>?<param>=<value>&<param>=<value>…
```

The **authority** is the action; everything else is URL-encoded query
parameters. The *site's* own host goes in `?host=`, not in the URL authority.

Four actions:

### `faro://grant` — accept delegated access to one or many servers

Opens a **consent dialog** for an access grant issued by a trusted service
(e.g. an agency's ServerKit panel): the issuer mints a token, Faro fetches the
list of granted servers, and — only after the user clicks **Accept** — creates
a fresh on-device key and imports the servers as ordinary connections. The
link carries a redemption token, never a credential.

```
faro://grant?issuer=https%3A%2F%2Fpanel.agency.com&token=gr_9f2kQ7
```

The full open protocol (manifest schema, key exchange, issuer requirements) is
specified in **`docs/grant-links.md`**.

### `faro://connect` — open a server connection

Prefills the editor for an SFTP/FTP/FTPS/S3/Azure server, or a WordPress
site's REST API (`protocol=wordpress`, `host` = the site address).

| Param      | Meaning                                              | Example                 |
|------------|------------------------------------------------------|-------------------------|
| `protocol` | `sftp` \| `ftp` \| `ftps` \| `s3` \| `azure` \| `wordpress` | `sftp`             |
| `host`     | Server hostname or IP                                | `wp-prod.example.com`   |
| `port`     | Port (defaults per protocol if omitted)              | `22`                    |
| `username` | Login user (no password!)                            | `wp_deploy`             |
| `path`     | Default remote directory to open                     | `/home/wp/public_html`  |
| `name`     | Friendly connection name shown in Faro               | `My WordPress (prod)`   |
| `bucket`   | S3 bucket / Azure container (object stores)          | `site-assets`           |
| `region`   | S3 region                                            | `us-east-1`             |
| `endpoint` | S3-compatible endpoint (R2/B2/MinIO)                 | `https://…r2.cloudflarestorage.com` |
| `account`  | Azure storage account                                | `mystorageacct`         |

**Example — a WordPress site's REST API (no FTP/SSH needed; the admin pastes
an Application Password in Faro):**

```
faro://connect?protocol=wordpress&host=https%3A%2F%2Fexample.com&username=admin&name=Example%20(WP)
```

**Example — a WordPress site's SFTP, straight into the web root:**

```
faro://connect?protocol=sftp&host=wp-prod.example.com&port=22&username=wp_deploy&path=%2Fhome%2Fwp%2Fpublic_html&name=My%20WordPress%20(prod)
```

### `faro://pair` — pair a Faro Agent machine

Prefills the **Faro Agent** editor to pair (and then control) a machine running
`faro-agentd` — e.g. the box ServerKit itself runs on.

| Param  | Meaning                                             | Example          |
|--------|-----------------------------------------------------|------------------|
| `host` | Machine's hostname or IP                            | `10.0.0.20`      |
| `port` | Agent port (default `8722`)                         | `8722`           |
| `code` | The 6-digit pairing code (one-time; **not** a secret) | `428170`       |
| `name` | Friendly name                                       | `ServerKit host` |

**Example:**

```
faro://pair?host=10.0.0.20&port=8722&code=428170&name=ServerKit%20host
```

The pairing code is a short-lived, single-use consent token (it authenticates
the *first* handshake and is then useless — the machines pin each other's keys),
so it's safe to put in a link that the panel shows to its own logged-in admin.
Still, generate it right before showing the link — see the ServerKit note below.

### `faro://terminal` — open a standalone terminal window

Opens a terminal for a server in its own window (no file manager, just the
shell). The server is matched against saved connections by `name` or `host`
and must **already be connected** in Faro — a link never opens a new
connection or carries credentials. If it isn't connected, Faro falls back to
the prefilled connection editor. Terminals require an SFTP connection.

| Param  | Meaning                                   | Example      |
|--------|-------------------------------------------|--------------|
| `name` | Connection name to match (case-insensitive) | `My Site`  |
| `host` | Alternative match by hostname or IP       | `10.0.0.20`  |

**Example:**

```
faro://terminal?name=My%20Site
```

## Generating links (any language)

A link is just a string; URL-encode every value. Illustrative helpers:

```js
// JavaScript
function faroConnect(p) {
  const q = new URLSearchParams(
    Object.entries(p).filter(([, v]) => v != null && v !== "")
  );
  return `faro://connect?${q}`;
}
faroConnect({ protocol: "sftp", host: "wp.example.com", port: 22,
              username: "wp_deploy", path: "/home/wp/public_html",
              name: "My WordPress (prod)" });
```

```php
// PHP (ServerKit is PHP-friendly)
function faro_connect(array $p): string {
  $q = http_build_query(array_filter($p, fn($v) => $v !== null && $v !== ''));
  return "faro://connect?$q";
}
```

```html
<a href="faro://connect?protocol=sftp&host=wp.example.com&port=22&username=wp_deploy&path=%2Fhome%2Fwp%2Fpublic_html&name=My%20WordPress">
  Connect with Faro
</a>
```

## Integrating with ServerKit

A natural fit for a "Connect with Faro" button on each site/service card:

1. **SFTP/FTP to a hosted site** — emit a `faro://connect` link from the site's
   stored protocol, host, port, and system user, with `path` set to the doc
   root (e.g. WordPress `public_html`). Leave the password out; the admin types
   it once in Faro (or uses a key). This is the "easy link to this WordPress
   server" case.
2. **Control the ServerKit host machine itself** — run the bundled agent on the
   box (`faro-agentd install` as a service, or `faro-agentd pair --json` to get
   a code programmatically) and render a `faro://pair` link with the freshly
   generated code. `--json` prints `{"event":"pairing","code":…,"port":…}` on
   the first line, so the panel can read the code, build the link, and show it
   to the admin — no screen-scraping.
3. A dedicated **"faro-agent" ServerKit extension** can bundle both: a per-site
   Connect link and a per-server Pair link, plus a one-liner to install the
   daemon (see `docs/remote-agent.md` → Distribution).

Because links are plain strings and the daemon speaks a documented protocol,
nothing in ServerKit needs to link against Faro — it just generates URLs and,
optionally, shells out to `faro-agentd`.

## Platform notes

- **Windows / Linux** — the scheme is registered by the installer; a link
  launches Faro if closed, or focuses the running window (single-instance) and
  forwards the URL. In a dev build Faro registers the scheme at startup.
- **macOS** — registered via the app bundle's `Info.plist`; the OS routes links
  to the running app.
- Firefox/Chrome will ask "Open Faro?" the first time — expected for any
  protocol handler.

# Faro access grants (`faro://grant`)

An **access grant** lets an agency, a hosting panel, or any server-fleet owner
hand someone time-boxed SSH/SFTP access to **one or many servers with a single
link** — without ever handing them a password or the owner's private key.

The flow in one paragraph: the issuer (e.g. a ServerKit extension) keeps the
real access and mints a **grant token**. The link carries only the token.
Faro fetches a manifest describing the granted servers, shows the user exactly
what access is being offered, and — only after the user clicks **Accept** —
generates a **fresh ed25519 keypair on the user's machine**, uploads the
*public* key to the issuer, and imports the servers as ordinary Faro
connections. The issuer installs that public key on the granted servers (and
optional bastion). Revoking the grant = removing that public key; it never
touches the owner's own credentials.

This document is the **open protocol spec** — `Faro Grant Protocol v1`. It is
deliberately issuer-agnostic: ServerKit is the reference issuer, but anything
that can serve two HTTPS endpoints and install an `authorized_keys` line can
issue grants.

## Security model — same rules as deep links, plus tokens

Everything in `docs/deep-links.md` applies, extended:

- **A link never connects on its own.** `faro://grant` opens a consent dialog.
  The user sees the issuer, the grant name, every server in the bundle, and the
  expiry before anything is imported or uploaded.
- **A link never carries a server credential.** The token is a *redemption
  token* for the issuer's API — it is not an SSH password, and it never
  becomes one. It is unguessable (≥ 128 bits), single-use or short-lived,
  and useless once redeemed or expired.
- **Private keys are born on the user's machine and never leave it.** Faro
  uploads only the *public* key. The private key goes straight into the OS
  keychain (`credentials.rs`), never into `profiles.json`, never over IPC.
- **The issuer is the trust anchor.** Faro validates that `issuer` is an HTTPS
  URL (plain `http` is accepted only for loopback hosts, for local
  development) and requires manifest `version: 1`.

## The link

```
faro://grant?issuer=<base-url>&token=<token>[&name=<label>]
```

| Param    | Required | Meaning |
|----------|----------|---------|
| `issuer` | yes      | HTTPS base URL of the issuing service, e.g. `https://panel.agency.com`. No path, or a path prefix the issuer serves under. |
| `token`  | yes      | The grant token. Opaque to Faro; `[A-Za-z0-9_-]{16,128}`. |
| `name`   | no       | Fallback human label until the manifest is fetched. |

Example:

```
faro://grant?issuer=https%3A%2F%2Fpanel.agency.com&token=gr_9f2kQ7&name=Client%20X%20servers
```

## The exchange

Both endpoints live under the issuer base URL. `{token}` is path-encoded.

### 1. `GET {issuer}/.well-known/faro-grant/{token}` — fetch manifest

Called when the dialog opens, **before** consent, so the user can see what is
being granted. No authentication beyond the token itself.

**200 OK** → manifest:

```json
{
  "version": 1,
  "issuer": "ServerKit · panel.agency.com",
  "name": "Client X — 5 servers",
  "group": "Agency / Client X",
  "expires_at": "2026-08-07T00:00:00Z",
  "auth": { "type": "key-install" },
  "connections": [
    {
      "name": "web-1",
      "protocol": "sftp",
      "host": "10.0.0.11",
      "port": 22,
      "username": "deploy",
      "path": "/var/www",
      "jump": {
        "host": "bastion.agency.com",
        "port": 22,
        "username": "faro-grant"
      }
    }
  ]
}
```

Manifest fields:

| Field | Req | Meaning |
|-------|-----|---------|
| `version` | yes | Must be `1`. |
| `issuer` | yes | Display name of the issuing org/service. |
| `name` | yes | Display name of the grant. |
| `group` | no | Faro rail folder the imported profiles land in. Defaults to `issuer`. |
| `expires_at` | no | RFC 3339. Informational — enforcement is the issuer's job. |
| `auth.type` | yes | Only `"key-install"` in v1: Faro uploads a public key (step 2). |
| `connections` | yes | 1–64 entries. |
| `connections[].protocol` | yes | `"sftp"` in v1 (plain SSH). |
| `connections[].host/port/username` | yes | Target SSH endpoint. `host` is a DNS name or IP — never a URL. |
| `connections[].name`, `.path` | no | Display name, default remote path. |
| `connections[].jump` | no | Bastion/ProxyJump hop. Faro connects to `jump.host`, then tunnels to the target over a direct-tcpip channel. The **same key** authenticates both hops — the issuer must install the uploaded public key on the jump host too. This is how an agency gives every developer the same static source IP. |

Errors: `404` unknown/redeemed/expired token · `410` revoked · `429` rate
limited. Body `{ "error": "..." }` optional.

### 2. `POST {issuer}/.well-known/faro-grant/{token}/key` — upload public key

Called **only after the user clicks Accept**. Body:

```json
{ "public_key": "ssh-ed25519 AAAAC3NzaC… faro-grant" }
```

The issuer validates the token again, installs the key on every listed server
(and jump hosts), marks the token redeemed, and replies:

**200 OK** →

```json
{ "installed": ["web-1", "web-2"], "failed": [] }
```

`failed` entries are `{ "name": "…", "error": "…" }` objects; Faro imports the
successful ones and reports the rest. On total failure, a non-200 with
`{ "error": "…" }` and nothing is imported.

## Issuer requirements (checklist for implementors)

1. Tokens: `secrets.token_urlsafe(24)` or better; store **hashed**; TTL +
   one-time redemption; rate-limit both endpoints.
2. Install keys via your fleet mechanism — append one line to
   `~/.ssh/authorized_keys` of the grant's username on each server (and jump
   host). Remove that same line on revoke/expiry.
3. Never put server passwords or your own private keys in a manifest. The
   uploaded public key is the only credential material in the protocol.
4. Serve the endpoints over HTTPS with a valid certificate.
5. Recommended: dedicated low-privilege grant usernames on target servers,
   `from="<bastion-ip>"` restrictions on installed keys, and an audit log of
   issue/redeem/revoke events.

The reference issuer is the ServerKit extension
[`serverkit-faro`](https://github.com/jhd3197/serverkit-faro).

## What Faro does with a manifest (client behavior)

1. Validate: HTTPS issuer (loopback `http` allowed for dev), token charset,
   `version == 1`, 1–64 connections, sane hosts/ports. Reject otherwise.
2. Show the consent dialog: issuer, grant name, expiry, full server list.
3. On **Accept**: generate ed25519 keypair in memory → `POST` public key →
   store private key in OS keychain (`grant-key:<profile-id>`) → upsert one
   profile per connection with `auth: { kind: "keyref", keyRef }`, the
   manifest's `group`, and jump fields where present.
4. Imported connections are ordinary Faro profiles: SFTP browsing, terminal,
   folder sync — everything works, including through the bastion hop.
5. Nothing about a grant profile is special after import. When the issuer
   revokes the key, connections simply start failing auth — the user deletes
   the group.

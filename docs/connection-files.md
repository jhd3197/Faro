# Faro connection files (`.faro`)

**Export…** (a connection's or group's rail menu, or File > Export all
connections) writes the chosen connections to a `.faro` file, and the **Faro
file** tab in Import reads it back, on this machine or a teammate's. Dropping a
`.faro` file on the window opens it in Import.

## What travels

Each connection's protocol, host, port, user, default path, group, icon and
colour, its route (Cloudflare Access hostname and service token id, jump host,
proxy, proxy command) and its login type. A connection's jump hosts are always
added, so its route still works on the other side.

**No secrets by default.** Saved passwords, key passphrases, proxy passwords,
Access service token secrets and keys kept in the keychain are left out. Key
file paths are kept as hints, since they're machine-specific. Import marks what
each connection still needs: *needs a key*, *needs a password*, *needs sign-in*
(cloud drives) or *needs token secret*. Connections that log in with the SSH
agent or a Cloudflare short-lived certificate need nothing, so a shared file is
a complete onboarding for them.

**Include secrets** adds them and encrypts the whole file with a passphrase, in
the encrypted backup's container (Argon2id + AES-256-GCM) under its own magic
`FAROCON\x01`. Import asks for the passphrase. Cloud drive sign-ins are never
exported; sign in again after importing.

## Duplicates

A row that matches an existing connection, by name or by protocol, host, port
and user, offers **Skip** (the default), **Import as copy** or **Replace**.
Replace keeps the existing connection's saved secrets when the file brought
none.

## Format

A plain file is JSON:

```json
{
  "format": "faro-connections",
  "version": 1,
  "exportedMs": 1793000000000,
  "secrets": false,
  "connections": [ { "id": "…", "name": "Prod box", "protocol": "sftp", "host": "ssh.example.com", "port": 22, "username": "jane.doe", "auth": { "kind": "cloudflarecert" }, "proxyCommand": { "kind": "cloudflare" }, "group": "Prod" } ]
}
```

Each connection has the same fields as `profiles.json`. Ids only link jump
hosts inside the file; imported connections get new ones. A file with a newer
`version` is refused with a message to update Faro.

## Other ways out

- **Copy link** writes a `faro://connect` link for one connection, with no
  secrets (see `deep-links.md`).
- **Export as OpenSSH config…** writes a `Host` block per SSH connection, with
  `ProxyJump`, `ProxyCommand cloudflared access ssh --hostname %h` and
  `CertificateFile`. A Cloudflare certificate login also gets a
  `Match host … exec "cloudflared access ssh-gen …"` line so OpenSSH fetches the
  certificate itself. The OpenSSH tab in Import reads it back with the same
  routes and login types.

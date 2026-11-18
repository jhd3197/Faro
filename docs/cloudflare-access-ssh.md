# Let people log in with their Cloudflare sign-in

When you connect to a server with **Cloudflare sign-in**, Cloudflare Access
issues a short-lived SSH certificate for you. The certificate is named after
your email: `jane.doe@example.com` gets a certificate for `jane.doe`.

Out of the box, OpenSSH only accepts that certificate for the account with the
same name (`jane.doe`). To log in to a shared account such as `deploy`, the
server has to say who may use it.

> If Faro shows *"Cloudflare issued a certificate for `jane.doe`, but the server
> refused it for user `deploy`"*, this page is the fix. Send it to the server's
> admin.

There are two ways to set this up:

- **[Listed people](#listed-people) (recommended).** The server keeps a list of
  who may log in as each account. Adding someone means adding a line.
- **[Anyone the Access policy allows](#anyone-the-access-policy-allows)
  (opt-in).** The server accepts any certificate from your Access team for the
  accounts you choose, so access is managed only in Cloudflare.

Both need the Access CA trusted first.

**Faro can do this for you.** If you can already log in to the server with
Faro another way (your own key or password, with root or sudo), edit the
Cloudflare connection: **Cloudflare login on the server** shows which way the
server is set up, adds and removes listed people, and turns the opt-in on or
off. It shows the exact files and commands first, backs them up, checks
`sshd_config` with `sshd -t`, reloads sshd (your session stays open), tries a
certificate login, and puts the backup back if any step fails. When someone's
sign-in is refused and you have that admin login saved, the error offers
**Allow *name* to log in as *user*** in one click. The steps below are the
same changes, by hand.

## What you need

- Root on the server.
- The public key of the SSH application's certificate authority (CA) in
  Cloudflare Zero Trust. If the server was set up with Faro's **Move behind
  Cloudflare**, the CA and the listed-people setup below are already in place:
  use **Share › Invite…** on the connection to add someone.

## 1. Trust the Access CA

Skip this if `TrustedUserCAKeys` already points at the Access CA in
`/etc/ssh/sshd_config`.

```sh
# Paste the CA public key (one line starting with ecdsa-sha2-nistp256 …)
sudo tee /etc/ssh/faro_cloudflare_ca.pub
sudo chmod 644 /etc/ssh/faro_cloudflare_ca.pub
```

Add near the top of `/etc/ssh/sshd_config`, before any `Match` block:

```
TrustedUserCAKeys /etc/ssh/faro_cloudflare_ca.pub
```

## Listed people

Each account gets a file listing the certificate names that may log in as it,
one per line. Add this line to `/etc/ssh/sshd_config`, next to the one above:

```
AuthorizedPrincipalsFile /etc/ssh/faro_principals/%u
```

Then, to let `jane.doe` log in as `deploy`:

```sh
sudo mkdir -p /etc/ssh/faro_principals
echo jane.doe | sudo tee -a /etc/ssh/faro_principals/deploy
```

To let her log in as her own account too, add `jane.doe` to
`/etc/ssh/faro_principals/jane.doe`. With this line in place, an account with no
file accepts no certificates. Remove a line to take someone's access away. The
Access policy still has to let them in as well.

## Anyone the Access policy allows

**Opt-in.** Anyone your Access policy admits can then log in as the accounts you
list here, without being added on the server. Use it when Cloudflare is where
you manage who gets in. Removing someone from the policy takes effect at their
next sign-in, and certificates expire within minutes.

This small script prints the names inside the certificate sshd is checking.
sshd only asks after it has confirmed the certificate was signed by the trusted
CA, so a certificate from anywhere else is still refused.

```sh
sudo tee /usr/local/sbin/faro-access-principals >/dev/null <<'EOF'
#!/bin/sh
printf '%s %s\n' "$1" "$2" | ssh-keygen -L -f /dev/stdin 2>/dev/null |
  awk '/^[[:space:]]*Principals:/ {p=1; next} /^[[:space:]]*Critical Options:/ {p=0} p {print $1}'
EOF
sudo chown root:root /usr/local/sbin/faro-access-principals
sudo chmod 755 /usr/local/sbin/faro-access-principals
```

Then add at the **end** of `/etc/ssh/sshd_config`, listing the accounts that
anyone in the Access policy may use:

```
Match User deploy,www-data
    AuthorizedPrincipalsCommand /usr/local/sbin/faro-access-principals %t %k
    AuthorizedPrincipalsCommandUser nobody
```

This works alongside the listed-people file: other accounts keep their lists.

## Check and reload

```sh
sudo sshd -t && sudo systemctl reload ssh   # or: reload sshd
```

Then use **Try again** in Faro.

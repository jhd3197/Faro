# Let the Cloudflare Access policy decide who logs in

When you connect to a server with **Cloudflare sign-in**, Cloudflare Access
issues a short-lived SSH certificate for you. The certificate is named after
your email: `jane.doe@example.com` gets a certificate for `jane.doe`.

Out of the box, OpenSSH only accepts that certificate for the account with the
same name (`jane.doe`). To log in to a shared account such as `deploy`, the
server has to say who may use it. Listing people one by one in a principals
file works, but then every new teammate means editing every server.

This guide sets the server up once so that **anyone the Access policy lets
through can log in as the accounts you choose**. Adding or removing a person
happens in the Access policy, not on the server.

> If you see *"Cloudflare issued a certificate for `jane.doe`, but the server
> refused it for user `deploy`"* in Faro, this is the fix. Send this page to the
> server's admin.

## What you need

- Root on the server.
- The public key of the SSH application's certificate authority (CA) in
  Cloudflare Zero Trust. If the server was set up with Faro's **Move behind
  Cloudflare**, it is already at `/etc/ssh/faro_cloudflare_ca.pub`.

## 1. Trust the Access CA

Skip this if `TrustedUserCAKeys` already points at the Access CA in
`/etc/ssh/sshd_config`.

```sh
# Paste the CA public key (one line starting with ecdsa-sha2-nistp256 …)
sudo tee /etc/ssh/cloudflare_access_ca.pub
sudo chmod 644 /etc/ssh/cloudflare_access_ca.pub
```

Add near the top of `/etc/ssh/sshd_config`, before any `Match` block:

```
TrustedUserCAKeys /etc/ssh/cloudflare_access_ca.pub
```

## 2. Accept any Access certificate for the shared accounts

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

## 3. Check and reload

```sh
sudo sshd -t && sudo systemctl reload ssh   # or: reload sshd
```

Then use **Try again** in Faro.

## What this allows, and what it doesn't

- Anyone the Access policy admits can log in as the accounts in the `Match User`
  line. Remove someone from the policy and they lose access at their next
  sign-in; certificates expire within minutes.
- Other accounts keep the normal rule: a certificate for `jane.doe` only logs in
  as `jane.doe`.
- Certificates not signed by the Access CA are refused, as before.
- Want a per-person list for one account instead? Keep using
  `AuthorizedPrincipalsFile` for that account and leave it out of the
  `Match User` line.

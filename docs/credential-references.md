# External credential references

Configure a local adapter in `credential-providers.json` in Faro's application
data directory. The CLI honors `FARO_DATA_DIR`; otherwise the directory is
`com.juandenis.faro` under the operating system's application data directory.

```json
{
  "vault": {
    "program": "C:\\Tools\\vault-adapter.exe",
    "args": ["read", "--", "{item}"]
  }
}
```

Use an absolute executable path. On Windows it must be an `.exe`. The adapter
must print only the requested password or key passphrase to stdout and exit
successfully. One trailing newline is removed. Unlock or authenticate your
password manager before connecting; adapters run without an interactive stdin.
Faro limits execution to 20 seconds and output to 64 KiB, and hides adapter
stderr and output from errors.

In the connection editor choose the configured Credential source and enter its
item identifier. Faro substitutes an entire `{item}` argument, without a shell.
Use an adapter that treats the item as a value, not executable input. References
starting with `-` or containing line breaks are refused.

References work with password authentication and private-key passphrases. Each
gateway resolves its own reference. Values are fetched when a new session opens;
reconnect the session after rotating a credential. Files and exports retain the
reference and clear any embedded password or passphrase. The local adapter
configuration is deliberately excluded from backups and connection exports:
configure a trusted adapter on each computer before using imported references.

# Vendored suppaftp 6.3.0 (patched)

Upstream: https://github.com/veeso/suppaftp — MIT OR Apache-2.0, by
Christian Visintin. Wired in through `[patch.crates-io]` in
`src-tauri/Cargo.toml`.

## Why

suppaftp writes every command as UTF-8 and decodes listings with
`from_utf8_lossy`. Against a server that uses another charset (Latin-1,
Windows-1252, Shift_JIS, GBK, ...) any non-ASCII name comes back mangled,
and the mangled name gets sent back on the next command. The server then
can't find the path, and many servers answer `LIST` on a missing path
with an empty listing (Faro issue #24). No upstream release, up to 12.x,
has a hook for this.

## The patch (sync client only)

- `types::TextCodec`: an encoder/decoder pair (`encode_text`,
  `decode_text`), exported from the crate root. Encoding is fallible: text
  the charset can't represent fails with the new `FtpError::TextEncoding`
  instead of being substituted, which would address a different path.
- `ImplFtpStream::set_text_codec(Option<TextCodec>)`: when set, `perform`
  encodes each command with it, and `LIST`/`NLST`/`MLSD` lines, `PWD` and
  `MLST` replies are decoded with it. The codec carries over through
  `into_secure`.

Also fixed: in active mode the accepted data socket is switched back to
blocking. On Windows it inherits the listener's non-blocking mode, so every
active-mode transfer failed with WouldBlock (surfacing as `BadResponse`).

Rustls shutdown now flushes `close_notify`, half-closes the TCP writer, and
drains the peer's TLS shutdown with a two-second limit. On Windows, closing
with unread TLS session tickets could reset the data connection and truncate
an upload. `scripts/audit-ftp-sftp.py --live` covers encrypted CLI and app
transfers against a local FTPS server.

With no codec set, text encoding matches upstream. When updating suppaftp,
retain these fixes until equivalent behavior is verified upstream.

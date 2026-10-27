import type { ConnectionProfile } from "@/lib/types";

// "Copy link": a connection as a `faro://connect` deep link (docs/deep-links.md).
// Never carries a secret, and only what the link grammar can prefill.

const LINKABLE = new Set([
  "sftp", "ftp", "ftps", "s3", "azure", "gcs", "webdav", "http",
  "dropbox", "onedrive", "gdrive", "box", "shopify", "hubspot", "dynamics", "wordpress",
]);

export const canLink = (p: ConnectionProfile) => LINKABLE.has(p.protocol);

export function connectLink(p: ConnectionProfile): string {
  const q = new URLSearchParams();
  const set = (k: string, v: string | number | undefined | null) => {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  };
  set("protocol", p.protocol);
  set("host", p.host);
  set("port", p.port);
  set("username", p.username);
  set("path", p.defaultRemotePath && p.defaultRemotePath !== "." ? p.defaultRemotePath : undefined);
  set("name", p.name);
  set("bucket", p.bucket);
  set("region", p.region);
  set("endpoint", p.protocol === "wordpress" ? undefined : p.endpoint);
  set("account", p.account);
  if (p.protocol === "sftp") {
    if (p.proxyCommand?.kind === "cloudflare") {
      set("via", "cloudflare");
      set("access", p.proxyCommand.hostname);
    }
    if (p.auth.kind === "agent" || p.auth.kind === "cloudflarecert") set("auth", p.auth.kind);
  }
  // URLSearchParams writes spaces as "+"; "%20" reads the same everywhere.
  return `faro://connect?${q.toString().replace(/\+/g, "%20")}`;
}

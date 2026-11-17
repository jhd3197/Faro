import type { ConnectionProfile, DeepLink } from "@/lib/types";

// Which saved connection a `faro://connect` / `faro://site` link points at, so
// a panel's "Open in Faro" button reuses it instead of creating a duplicate.

const norm = (v?: string | null) => (v ?? "").trim().toLowerCase();

/** The Cloudflare Access hostname a profile reaches its server through, or "". */
function accessHost(p: ConnectionProfile): string {
  return p.proxyCommand?.kind === "cloudflare" ? norm(p.proxyCommand.hostname || p.host) : "";
}

/**
 * The saved profile a link describes, or null. Host must match (case and
 * surrounding space ignored), and so must every other identifying field the
 * link carries: protocol, port, username, and the Cloudflare Access hostname
 * when the link routes through Cloudflare. When the link has no username,
 * only a single host match counts, so it never guesses between two logins.
 */
export function matchLinkProfile(profiles: ConnectionProfile[], dl: DeepLink): ConnectionProfile | null {
  const host = norm(dl.host);
  if (!host) return null;
  const candidates = profiles.filter((p) => {
    if (p.protocol === "faro-agent") return false;
    if (dl.protocol && norm(dl.protocol) !== p.protocol) return false;
    // WordPress keeps the site URL in `endpoint`; a link's host is that URL.
    const hosts = [norm(p.host), p.protocol === "wordpress" ? norm(p.endpoint) : ""];
    if (!hosts.includes(host)) return false;
    if (dl.port && p.port && dl.port !== p.port) return false;
    if (dl.username && dl.username.trim() !== (p.username ?? "").trim()) return false;
    if (dl.via === "cloudflare" && accessHost(p) !== norm(dl.access || dl.host)) return false;
    return true;
  });
  if (dl.username) return candidates[0] ?? null;
  return candidates.length === 1 ? candidates[0] : null;
}

/** Normalize a remote folder so `/var/www/` and `/var/www` are the same site. */
export function sameRemotePath(a: string, b: string): boolean {
  return cleanRemotePath(a) === cleanRemotePath(b);
}

/** A folder without its trailing slash (`/` stays `/`). */
export function cleanRemotePath(p: string): string {
  return p.trim().replace(/\/+$/, "") || "/";
}

/** The site name a link implies: its `name`, else the folder's last segment. */
export function siteNameFor(dl: DeepLink, path: string): string {
  return dl.name?.trim() || path.split(/[/\\]/).filter(Boolean).pop() || path;
}

// Quick connect (Plan 36 Phase 3): type `user@host` in the command palette and
// connect, without filling in the New Connection form.
//
// The connection is tried with the SSH agent / default keys. When that works
// the host is kept as a normal saved connection; when it doesn't, nothing is
// left behind, and a sign-in failure opens the editor with the address filled
// in so a password or key can be added.

import type { ConnectionProfile } from "./types";

export interface QuickTarget {
  username: string;
  host: string;
  port: number;
}

const HOST = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?)$/;
const USER = /^[a-zA-Z0-9._][a-zA-Z0-9._-]*\$?$/;

function validPort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : null;
}

/** Parse `user@host`, `user@host:port`, `ssh user@host -p 2222` or
 *  `sftp://user@host:port`. Null for anything else, so ordinary palette
 *  searches are never taken for an address. */
export function parseQuickConnect(input: string): QuickTarget | null {
  let text = input.trim();
  if (!text.includes("@")) return null;
  let port: number | null = null;

  const scheme = /^(ssh|sftp):\/\//i.exec(text);
  if (scheme) {
    text = text.slice(scheme[0].length).replace(/\/.*$/, "");
  } else if (/^ssh\s+/i.test(text)) {
    const words = text.split(/\s+/).slice(1);
    const rest: string[] = [];
    for (let i = 0; i < words.length; i++) {
      if (words[i] === "-p") {
        port = validPort(words[++i] ?? "");
        if (port === null) return null;
      } else if (/^-p\d+$/.test(words[i])) {
        port = validPort(words[i].slice(2));
        if (port === null) return null;
      } else if (words[i].startsWith("-")) {
        return null; // an option this doesn't understand: don't guess
      } else {
        rest.push(words[i]);
      }
    }
    if (rest.length !== 1) return null;
    text = rest[0];
  }
  if (/\s/.test(text)) return null;

  const at = text.lastIndexOf("@");
  const username = text.slice(0, at);
  let host = text.slice(at + 1);
  // `host:port`, but not the colons inside a bracketed IPv6 address.
  const colon = host.startsWith("[") ? host.indexOf("]:") + 1 : host.lastIndexOf(":");
  if (colon > 0) {
    const p = validPort(host.slice(colon + 1));
    if (p === null) return null;
    port = p;
    host = host.slice(0, colon);
  }
  if (!USER.test(username) || !HOST.test(host)) return null;
  return { username, host: host.replace(/^\[|\]$/g, ""), port: port ?? 22 };
}

export function quickTargetLabel(t: QuickTarget): string {
  const host = t.host.includes(":") ? `[${t.host}]` : t.host;
  return t.port === 22 ? `${t.username}@${host}` : `${t.username}@${host}:${t.port}`;
}

/** A saved connection that already points at this target. */
export function findSavedTarget(
  profiles: ConnectionProfile[],
  t: QuickTarget
): ConnectionProfile | undefined {
  return profiles.find(
    (p) =>
      p.protocol === "sftp" &&
      p.host.trim().toLowerCase() === t.host.toLowerCase() &&
      p.port === t.port &&
      p.username === t.username
  );
}

/** The connection a quick connect creates. */
export function quickProfile(t: QuickTarget, id: string): ConnectionProfile {
  return {
    id,
    name: quickTargetLabel(t),
    protocol: "sftp",
    host: t.host,
    port: t.port,
    username: t.username,
    auth: { kind: "agent" },
  };
}

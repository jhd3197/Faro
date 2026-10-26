// Agent Bridge access levels, resolved the same way the backend gate does
// (`bridge.rs` → `access_for_session` / `default_access`), so the access
// matrix, the agent drawer and the rail all show what will actually happen.

import type {
  AccessLevel,
  ApprovalPolicy,
  BridgeStatus,
  ConnectionProfile,
  ProfileAccess,
} from "./types";

export const ALL_OFF: ProfileAccess = {
  read: "off",
  write: "off",
  exec: "off",
  sudo: "off",
};

/** What a granted server without an explicit entry gets (mirrors Rust). */
export function defaultAccess(p: ApprovalPolicy): ProfileAccess {
  const lvl = (auto: boolean): AccessLevel => (auto ? "auto" : "ask");
  return {
    read: lvl(p.allowAll || p.autoRead),
    write: lvl(p.allowAll),
    exec: lvl(p.allowAll),
    sudo: p.allowSudo ? "ask" : "off",
  };
}

/** The levels in force for a saved connection. Ungranted → all off. */
export function effectiveAccess(
  status: BridgeStatus,
  profileId: string
): ProfileAccess {
  if (!status.enabledProfiles.includes(profileId)) return ALL_OFF;
  return status.profileAccess[profileId] ?? defaultAccess(status.policy);
}

export function grantsAny(a: ProfileAccess): boolean {
  return a.read !== "off" || a.write !== "off" || a.exec !== "off";
}

/** Which matrix columns apply to a protocol. Shell commands need an SSH or
 *  Faro Agent session; sudo answering is SSH-only. */
export function accessCaps(protocol: ConnectionProfile["protocol"]): {
  exec: boolean;
  sudo: boolean;
} {
  return {
    exec: protocol === "sftp" || protocol === "faro-agent",
    sudo: protocol === "sftp",
  };
}

export type AccessColumn = keyof ProfileAccess;

export const ACCESS_COLUMNS: {
  key: AccessColumn;
  label: string;
  /** Column-header form for the matrix. */
  short: string;
  help: string;
  /** Auto on this column is shown in the danger tone. */
  risky: boolean;
}[] = [
  { key: "read", label: "Browse & read", short: "Read", help: "List directories, read files, search", risky: false },
  { key: "write", label: "Transfer & write", short: "Write", help: "Uploads, downloads, deletes, renames, syncs", risky: true },
  { key: "exec", label: "Run commands", short: "Commands", help: "Shell commands over SSH or a Faro Agent", risky: true },
  { key: "sudo", label: "Sudo", short: "Sudo", help: "Off: never answer sudo · Ask: sudo always prompts · Auto: follows Run commands", risky: true },
];

/** Short summary for tooltips: "read Auto · write Ask · run Ask · sudo Off". */
export function accessSummary(a: ProfileAccess): string {
  const cap = (l: AccessLevel) => l[0].toUpperCase() + l.slice(1);
  return `read ${cap(a.read)} · write ${cap(a.write)} · run ${cap(a.exec)} · sudo ${cap(a.sudo)}`;
}

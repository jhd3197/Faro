// Password managers and SSH agents for the demo build (Plan 33). Made-up
// vaults: 1Password starts signed in, Bitwarden starts locked and unlocks with
// any non-empty master password. No command ever returns a secret value.
import type { AgentInfo, PmField, PmItem, PmState, PmStatus, ToolStatus } from "@/lib/types";

type Args = Record<string, any>;

interface MockItem extends PmItem {
  fields: PmField[];
}

const OP_ITEMS: MockItem[] = [
  {
    id: "q7hdx2kq4dnm3yqe5w7n6a2c1e",
    title: "prod-db",
    subtitle: "deploy",
    category: "Server",
    vault: "Infrastructure",
    url: "sftp://db.example.com",
    username: "deploy",
    fields: [
      { label: "username", reference: "op://Infrastructure/prod-db/username", kind: "username", concealed: false },
      { label: "password", reference: "op://Infrastructure/prod-db/password", kind: "password", concealed: true },
      { label: "notes", reference: "op://Infrastructure/prod-db/notesPlain", kind: "note", concealed: false },
    ],
  },
  {
    id: "m3u4slb6v5ixh2dc3wzk6pq7qa",
    title: "Staging SFTP",
    subtitle: "stage",
    category: "Login",
    vault: "Infrastructure",
    url: "sftp://staging.example.com:2222",
    username: "stage",
    fields: [
      { label: "username", reference: "op://Infrastructure/Staging SFTP/username", kind: "username", concealed: false },
      { label: "password", reference: "op://Infrastructure/Staging SFTP/password", kind: "password", concealed: true },
      { label: "one-time password", reference: "op://Infrastructure/Staging SFTP/one-time password", kind: "otp", concealed: true },
    ],
  },
  {
    id: "a1tnk6v7xq2d4lw9cz3e5r8hbm",
    title: "AWS deploy keys",
    subtitle: "AKIAEXAMPLE7Q2D",
    category: "API Credential",
    vault: "Cloud",
    fields: [
      { label: "access key id", reference: "op://Cloud/AWS deploy keys/access key id", kind: "text", concealed: false },
      { label: "secret access key", reference: "op://Cloud/AWS deploy keys/secret access key", kind: "password", concealed: true },
    ],
  },
  {
    id: "z8wq3e1r5t7y9u2i4o6p8a0s2d",
    title: "Office router",
    subtitle: "admin",
    category: "Login",
    vault: "Private",
    url: "https://192.0.2.1",
    username: "admin",
    fields: [
      { label: "username", reference: "op://Private/Office router/username", kind: "username", concealed: false },
      { label: "password", reference: "op://Private/Office router/password", kind: "password", concealed: true },
    ],
  },
];

const BW_FILES = "2f6b1c3e-7a9d-4e21-b8c4-5d0f3a6e9b12";
const BW_BACKUP = "8c4e2a1f-3b5d-4f7a-9e6c-1d2b3a4c5e6f";

const BW_ITEMS: MockItem[] = [
  {
    id: BW_FILES,
    title: "files.example.com",
    subtitle: "webadmin",
    category: "Login",
    vault: "My vault",
    url: "ftp://files.example.com",
    username: "webadmin",
    fields: [
      { label: "Username", reference: `${BW_FILES}/username`, kind: "username", concealed: false },
      { label: "Password", reference: `${BW_FILES}/password`, kind: "password", concealed: true },
      { label: "Authenticator key (TOTP)", reference: `${BW_FILES}/totp`, kind: "otp", concealed: true },
    ],
  },
  {
    id: BW_BACKUP,
    title: "Backup box",
    subtitle: "backup",
    category: "Login",
    vault: "Ops",
    url: "sftp://backup.example.net",
    username: "backup",
    fields: [
      { label: "Username", reference: `${BW_BACKUP}/username`, kind: "username", concealed: false },
      { label: "Password", reference: `${BW_BACKUP}/password`, kind: "password", concealed: true },
      { label: "passphrase", reference: `${BW_BACKUP}/field:passphrase`, kind: "password", concealed: true },
      { label: "Notes", reference: `${BW_BACKUP}/notes`, kind: "note", concealed: false },
    ],
  },
];

const BW_LOCKED = "Bitwarden is locked. Unlock it in Settings › Password managers.";

let opState: PmState = "ready";
let bwState: PmState = "locked";
let agents: Record<string, boolean> = { system: true, "1password": true, bitwarden: false };

// The CLIs themselves (managed_tools): where each comes from. A missing
// manager has no CLI; installing one leaves the manager signed out, as a
// fresh CLI would be.
const LATEST = { op: "2.42.0", bw: "2026.11.0" } as const;
type ToolId = keyof typeof LATEST;
let tools: Record<ToolId, { source: ToolStatus["source"]; version?: string; customPath?: string; checked: boolean }> = {
  op: { source: "path", version: "2.41.0", checked: false },
  bw: { source: "path", version: "2026.11.0", checked: false },
};
const MANAGED_DIR = "~/Library/Application Support/com.juandenis.faro/bin";
const TOOL_NAMES: Record<ToolId, string> = { op: "1Password CLI", bw: "Bitwarden CLI" };

function cliPath(id: ToolId): string | undefined {
  const t = tools[id];
  if (t.source === "missing") return undefined;
  if (t.source === "custom") return t.customPath;
  if (t.source === "managed") return `${MANAGED_DIR}/${id}`;
  return `/opt/homebrew/bin/${id}`;
}

function toolStatus(id: ToolId, message?: string): ToolStatus {
  const t = tools[id];
  const latest = t.checked ? LATEST[id] : undefined;
  return {
    id,
    name: TOOL_NAMES[id],
    source: t.source,
    path: cliPath(id),
    version: t.source === "missing" ? undefined : t.version,
    customPath: t.customPath,
    managedPath: `${MANAGED_DIR}/${id}`,
    latest,
    updateAvailable: !!latest && !!t.version && t.source !== "missing" && latest !== t.version,
    message,
  };
}

function managerState(id: ToolId): PmState {
  return id === "op" ? opState : bwState;
}

function setManagerState(id: ToolId, state: PmState) {
  if (id === "op") opState = state;
  else bwState = state;
}

/** Every password-manager command the UI sent, newest last (tests only). */
export const calls: { cmd: string; args: Args }[] = [];

/** Put a manager into a state (tests only). */
export function setState(next: { "1password"?: PmState; bitwarden?: PmState }) {
  if (next["1password"]) opState = next["1password"];
  if (next.bitwarden) bwState = next.bitwarden;
  for (const id of ["op", "bw"] as ToolId[]) {
    const state = managerState(id);
    if (state === "missing") tools[id] = { source: "missing", checked: tools[id].checked };
    else if (tools[id].source === "missing") tools[id] = { source: "path", version: LATEST[id], checked: tools[id].checked };
  }
}

/** Mark SSH agents running or not (tests only). */
export function setAgents(next: Record<string, boolean>) {
  agents = { ...agents, ...next };
}

export function reset() {
  opState = "ready";
  bwState = "locked";
  agents = { system: true, "1password": true, bitwarden: false };
  tools = {
    op: { source: "path", version: "2.41.0", checked: false },
    bw: { source: "path", version: "2026.11.0", checked: false },
  };
  calls.length = 0;
}

function status(): PmStatus[] {
  return [
    {
      id: "1password",
      name: "1Password",
      cliPath: cliPath("op"),
      state: opState,
      account: opState === "ready" ? "demo@example.com (my.1password.com)" : undefined,
      detail:
        opState === "missing"
          ? "The 1Password CLI isn't installed."
          : opState === "locked"
            ? "1Password didn't unlock. Approve the prompt in the 1Password app."
            : undefined,
    },
    {
      id: "bitwarden",
      name: "Bitwarden",
      cliPath: cliPath("bw"),
      state: bwState,
      account: bwState === "missing" || bwState === "signedOut" ? undefined : "demo@example.com",
      detail: bwState === "signedOut" ? "Bitwarden isn't signed in. Run `bw login` once in a terminal." : undefined,
    },
  ];
}

function vault(provider: string): MockItem[] {
  if (provider === "1password") {
    if (opState === "missing") throw "The 1Password CLI isn't installed.";
    if (opState !== "ready") throw "1Password didn't unlock. Approve the prompt in the 1Password app.";
    return OP_ITEMS;
  }
  if (provider === "bitwarden") {
    if (bwState === "missing") throw "The Bitwarden CLI isn't installed.";
    if (bwState === "signedOut") throw "Bitwarden isn't signed in. Run `bw login` once in a terminal.";
    if (bwState !== "ready") throw BW_LOCKED;
    return BW_ITEMS;
  }
  throw `Unknown password manager: ${provider}`;
}

const NAMES: Record<string, string> = { "1password": "1Password", bitwarden: "Bitwarden" };

function strip({ fields: _fields, ...item }: MockItem): PmItem {
  return item;
}

export function handle(cmd: string, a: Args): unknown {
  calls.push({ cmd, args: cmd === "password_manager_unlock" ? { provider: a.provider } : a });
  switch (cmd) {
    case "password_managers_status":
      return status();
    case "password_manager_unlock": {
      if (a.provider === "1password") {
        if (opState === "missing") throw "The 1Password CLI isn't installed.";
        opState = "ready";
        return null;
      }
      if (bwState === "missing") throw "The Bitwarden CLI isn't installed.";
      if (bwState === "signedOut") throw "Bitwarden isn't signed in. Run `bw login` once in a terminal.";
      if (!String(a.password ?? "")) throw "Enter your master password.";
      bwState = "ready";
      return null;
    }
    case "password_manager_lock":
      if (a.provider === "bitwarden" && bwState === "ready") bwState = "locked";
      return null;
    case "password_manager_items": {
      const q = String(a.query ?? "").trim().toLowerCase();
      return vault(a.provider)
        .filter((it) =>
          !q || [it.title, it.subtitle, it.username, it.url, it.vault].some((s) => s?.toLowerCase().includes(q))
        )
        .map(strip);
    }
    case "password_manager_fields": {
      const item = vault(a.provider).find((it) => it.id === a.itemId);
      if (!item) throw `That item no longer exists in ${NAMES[a.provider] ?? a.provider}.`;
      return item.fields;
    }
    case "credential_ref_test": {
      const ref = a.reference ?? {};
      const items = vault(ref.provider);
      const found = items.some((it) => it.fields.some((f) => f.reference === ref.item));
      if (!found) throw `That item no longer exists in ${NAMES[ref.provider] ?? ref.provider}.`;
      return null;
    }
    case "tool_status":
    case "tool_check":
    case "tool_install":
    case "tool_set_custom_path": {
      const id = a.id as ToolId;
      if (!(id in LATEST)) throw `Unknown tool: ${a.id}`;
      if (cmd === "tool_check") tools[id].checked = true;
      if (cmd === "tool_install") {
        tools[id] = { source: "managed", version: LATEST[id], checked: true };
        if (managerState(id) === "missing") setManagerState(id, "signedOut");
        return toolStatus(id, `Installed ${TOOL_NAMES[id]} ${LATEST[id]}`);
      }
      if (cmd === "tool_set_custom_path") {
        const path = typeof a.path === "string" && a.path.trim() ? a.path.trim() : undefined;
        if (path) {
          tools[id] = { ...tools[id], source: "custom", customPath: path, version: LATEST[id] };
          if (managerState(id) === "missing") setManagerState(id, "signedOut");
        } else {
          tools[id] = { ...tools[id], source: managerState(id) === "missing" ? "missing" : "path", customPath: undefined };
        }
      }
      return toolStatus(id);
    }
    case "ssh_agents": {
      const list: AgentInfo[] = [
        { id: "system", label: "System agent", path: "/private/tmp/com.apple.launchd.demo/Listeners", available: agents.system },
        { id: "1password", label: "1Password", path: "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock", available: agents["1password"] },
        { id: "bitwarden", label: "Bitwarden", path: "~/.bitwarden-ssh-agent.sock", available: agents.bitwarden },
      ];
      return list;
    }
  }
  return undefined;
}

export const COMMANDS = new Set([
  "password_managers_status",
  "password_manager_unlock",
  "password_manager_lock",
  "password_manager_items",
  "password_manager_fields",
  "credential_ref_test",
  "ssh_agents",
  "tool_status",
  "tool_check",
  "tool_install",
  "tool_set_custom_path",
]);

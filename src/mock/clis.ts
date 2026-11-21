// The CLIs page (Plan 35) in the demo build: made-up CLIs and accounts, a
// discovery answer per CLI, and hooks to expire a login so the status pill
// and the connect-time prompt can be driven (window.__demo.expireCli).
import { emit } from "./event";
import type { CliAccount, CliRole, CliState, CliToolStatus, ManagedToolId, ProfilePreview } from "@/lib/types";

type Args = Record<string, any>;

interface MockCli {
  name: string;
  roles: CliRole[];
  installed: boolean;
  version?: string;
  hasAccount: boolean;
  accounts: CliAccount[];
  signIn?: string;
  installUrl?: string;
}

const acct = (id: string, label = id, active = false, state: CliState = "ready"): CliAccount => ({ id, label, state, active });

function initial(): Record<string, MockCli> {
  return {
    cloudflared: { name: "cloudflared", roles: ["tunnel"], installed: true, version: "2026.11.0", hasAccount: false, accounts: [] },
    op: { name: "1Password CLI", roles: ["secrets"], installed: true, version: "2.42.0", hasAccount: false, accounts: [] },
    bw: { name: "Bitwarden CLI", roles: ["secrets"], installed: false, hasAccount: false, accounts: [] },
    aws: {
      name: "AWS CLI",
      roles: ["tunnel", "signIn", "discover"],
      installed: true,
      version: "2.22.4",
      hasAccount: true,
      accounts: [acct("default", "default (111122223333)", true), acct("client-a", "client-a (444455556666)")],
      signIn: "aws configure sso",
    },
    gcloud: { name: "Google Cloud CLI", roles: ["tunnel", "signIn", "discover"], installed: false, hasAccount: true, accounts: [], installUrl: "https://cloud.google.com/sdk/docs/install" },
    az: { name: "Azure CLI", roles: ["signIn", "discover"], installed: true, version: "2.67.0", hasAccount: true, accounts: [acct("sub-1", "Acme Prod (me@acme.dev)", true)], signIn: "az login" },
    gh: { name: "GitHub CLI", roles: ["signIn"], installed: true, version: "2.87.0", hasAccount: true, accounts: [acct("octo", "octo", true)], signIn: "gh auth login --hostname github.com --web" },
    tailscale: { name: "Tailscale", roles: ["discover"], installed: true, version: "1.78.1", hasAccount: true, accounts: [acct("acme.ts.net", "acme.ts.net", true)], signIn: "tailscale login" },
    doctl: { name: "DigitalOcean CLI", roles: ["discover"], installed: true, version: "1.117.0", hasAccount: true, accounts: [acct("me@acme.dev", "me@acme.dev", true)], signIn: "doctl auth init" },
    hcloud: { name: "Hetzner Cloud CLI", roles: ["discover"], installed: false, hasAccount: true, accounts: [], installUrl: "https://github.com/hetznercloud/cli/releases" },
    render: { name: "Render CLI", roles: ["discover"], installed: true, version: "2.28.0", hasAccount: true, accounts: [acct("me@acme.dev", "me@acme.dev", true)], signIn: "render login" },
    hs: { name: "HubSpot CLI", roles: ["discover"], installed: true, version: "7.2.0", hasAccount: true, accounts: [acct("12345678", "Acme Prod (12345678)", true), acct("87654321", "Acme Sandbox (87654321)")], signIn: "hs init" },
    shopify: { name: "Shopify CLI", roles: [], installed: true, version: "3.70.0", hasAccount: false, accounts: [] },
  };
}

let clis = initial();
const allowed = new Set<string>(["aws\u0000client-a"]);
const checkedAt: Record<string, number> = {};
export const calls: { cmd: string; args: Args }[] = [];

const DOCS = "https://example.com/docs";

function overall(c: MockCli): CliState {
  if (!c.installed) return "missing";
  if (!c.hasAccount) return "unknown";
  if (c.accounts.length === 0) return "signedOut";
  const active = c.accounts.find((a) => a.active) ?? c.accounts[0];
  if (active.state !== "ready") return active.state;
  return "ready";
}

function detail(id: string, c: MockCli, state: CliState): string | undefined {
  if (state === "missing") return `${c.name} isn't installed.`;
  if (state === "expired") {
    const a = c.accounts.find((x) => x.state === "expired");
    return id === "aws" && a ? `The login for profile ${a.id} expired. Click Sign in (runs \`aws sso login --profile ${a.id}\`).` : `Your ${c.name} login expired. Click Sign in (runs \`${c.signIn}\`).`;
  }
  if (state === "signedOut") return `Nobody is signed in to ${c.name}. Click Sign in (runs \`${c.signIn}\`).`;
  return undefined;
}

export function status(id: string): CliToolStatus {
  const c = clis[id];
  const state = overall(c);
  return {
    id: id as ManagedToolId,
    name: c.name,
    roles: c.roles,
    installed: c.installed,
    path: c.installed ? `C:\\Tools\\${id}.exe` : undefined,
    version: c.installed ? c.version : undefined,
    state,
    accounts: c.installed ? c.accounts.map((a) => ({ ...a, allowed: allowed.has(`${id}\u0000${a.id}`) })) : [],
    detail: detail(id, c, state),
    checkedAt: checkedAt[id] ?? 0,
    signIn: c.signIn,
    installUrl: c.installUrl,
    hasAccount: c.hasAccount,
    docsUrl: DOCS,
  };
}

const ssh = (name: string, host: string, user: string, group: string, tool: string, remoteId: string, extra: Record<string, unknown> = {}) => ({
  id: "",
  name,
  protocol: "sftp",
  host,
  port: 22,
  username: user,
  auth: { kind: "password" },
  group,
  cliSource: { tool, account: "", remoteId },
  ...extra,
});

let previewSeq = 0;
function preview(profile: any, note: string, needs: string[] = []): ProfilePreview {
  return {
    previewId: `pv-${++previewSeq}`,
    name: profile.name,
    protocol: profile.protocol,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    note,
    needs: needs as ProfilePreview["needs"],
    profile,
  } as ProfilePreview;
}

function discover(id: string, account: string | undefined): ProfilePreview[] {
  const c = clis[id];
  const a = c?.accounts.find((x) => x.id === account) ?? c?.accounts.find((x) => x.active);
  if (a && a.state !== "ready") throw `Your ${c.name} login expired. Sign in on the CLIs page, then try again.`;
  switch (id) {
    case "aws":
      return [
        preview(
          { id: "", name: "invoices", protocol: "s3", host: "", port: 443, username: "", auth: { kind: "password" }, bucket: "invoices", region: "eu-west-1", group: `AWS · ${a?.id}`, cliAuth: { tool: "aws", account: a?.id }, cliSource: { tool: "aws", account: a?.id, remoteId: "s3:invoices" } },
          "S3 bucket · eu-west-1"
        ),
        preview(
          ssh("web-1", "i-0abc123", "ec2-user", `AWS · ${a?.id}`, "aws", "ec2:i-0abc123", { proxyCommand: { kind: "awsSsm", target: "i-0abc123", cliAccount: a?.id, region: "us-east-1" } }),
          "EC2 i-0abc123 · through AWS SSM",
          ["key"]
        ),
      ];
    case "tailscale":
      return [
        preview(ssh("nas", "nas.acme.ts.net", "", "Tailscale · acme.ts.net", "tailscale", "node:n1"), "online · linux", ["key"]),
        preview(ssh("pi", "pi.acme.ts.net", "", "Tailscale · acme.ts.net", "tailscale", "node:n2"), "online · linux", ["key"]),
        preview(ssh("old-box", "old-box.acme.ts.net", "", "Tailscale · acme.ts.net", "tailscale", "node:n3"), "offline · linux", ["key", "offline"]),
      ];
    case "doctl":
      return [preview(ssh("api", "203.0.113.10", "root", "DigitalOcean", "doctl", "droplet:7"), "Droplet · nyc3", ["key"])];
    case "render":
      return [preview(ssh("api", "ssh.oregon.render.com", "srv-abc", "Render", "render", "service:srv-abc"), "Render service", ["key"])];
    case "hs":
      return [
        preview({ id: "", name: "Acme Prod (HubSpot)", protocol: "hubspot", host: "", port: 443, username: "", auth: { kind: "password" }, group: "HubSpot", cliSource: { tool: "hs", account: "12345678", remoteId: "portal:12345678" } }, "HubSpot portal 12345678", ["token"]),
      ];
    case "az":
      return [
        preview({ id: "", name: "acmestore/backups", protocol: "azure", host: "", port: 443, username: "", auth: { kind: "password" }, account: "acmestore", bucket: "backups", group: "Azure", cliAuth: { tool: "az", account: "sub-1" }, cliSource: { tool: "az", account: "sub-1", remoteId: "blob:acmestore/backups" } }, "Azure Blob container"),
      ];
  }
  return [];
}

export const COMMANDS = new Set(["cli_statuses", "cli_check", "cli_sign_in", "cli_set_allowed", "cli_discover", "cli_auth_test"]);

/** tool_* for the CLIs the password-manager mock doesn't own. */
export function ownsTool(id: unknown): boolean {
  return typeof id === "string" && id in clis && id !== "op" && id !== "bw";
}

function toolStatus(id: string) {
  const c = clis[id];
  return {
    id,
    name: c.name,
    roles: c.roles,
    installable: id === "cloudflared",
    installUrl: c.installUrl,
    source: c.installed ? "path" : "missing",
    path: c.installed ? `C:\\Tools\\${id}.exe` : undefined,
    version: c.installed ? c.version : undefined,
    managedPath: `C:\\Faro\\bin\\${id}.exe`,
    updateAvailable: false,
  };
}

export function handle(cmd: string, a: Args): unknown {
  calls.push({ cmd, args: a });
  if (cmd.startsWith("tool_")) {
    const c = clis[a.id];
    if (cmd === "tool_set_custom_path" && a.path) {
      c.installed = true;
      c.version ??= "1.0.0";
    }
    return toolStatus(a.id);
  }
  switch (cmd) {
    case "cli_statuses":
      return Object.keys(clis).map(status);
    case "cli_check": {
      if (!clis[a.id]) throw `Unknown CLI: ${a.id}`;
      checkedAt[a.id] = Math.floor(Date.now() / 1000);
      const s = status(a.id);
      emit("cli://status", s);
      return s;
    }
    case "cli_sign_in": {
      const c = clis[a.id];
      // The login "succeeds" a moment later, like the real window closing.
      setTimeout(() => {
        for (const x of c.accounts) if (!a.account || x.id === a.account) x.state = "ready";
        if (c.accounts.length === 0) c.accounts.push(acct("me@acme.dev", "me@acme.dev", true));
        checkedAt[a.id] = Math.floor(Date.now() / 1000);
        emit("cli://status", status(a.id));
      }, 300);
      return null;
    }
    case "cli_set_allowed": {
      const key = `${a.id}\u0000${a.account}`;
      if (a.allowed) allowed.add(key);
      else allowed.delete(key);
      return status(a.id);
    }
    case "cli_discover":
      return discover(a.id, a.account ?? undefined);
    case "cli_auth_test": {
      const auth = a.auth ?? {};
      if (!allowed.has(`${auth.tool}\u0000${auth.account || "default"}`)) throw `Faro isn't allowed to use your ${clis[auth.tool]?.name} login for ${auth.account || "default"} yet.`;
      return "Signed in. This credential lasts about 59 more minutes; Faro fetches a new one by itself.";
    }
  }
  return undefined;
}

/** Test hook: expire (or sign out) one account and tell the UI. */
export function expireCli(id: string, account?: string, state: CliState = "expired") {
  const c = clis[id];
  for (const x of c.accounts) if (!account || x.id === account) x.state = state;
  checkedAt[id] = Math.floor(Date.now() / 1000);
  emit("cli://status", status(id));
}

export function restoreCli(id: string) {
  const c = clis[id];
  for (const x of c.accounts) x.state = "ready";
  checkedAt[id] = Math.floor(Date.now() / 1000);
  emit("cli://status", status(id));
}

export function resetClis() {
  clis = initial();
  allowed.clear();
  allowed.add("aws\u0000client-a");
}

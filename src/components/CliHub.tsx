import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, FolderOpen, LogIn, RefreshCw, Search, TerminalSquare, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useClis } from "@/stores/cliStore";
import { useConnections } from "@/stores/connectionsStore";
import { useLayout } from "@/stores/layoutStore";
import { HOW_LABEL, STATE_LABEL, isProblem, stateForUse, usageByTool, type ToolUse } from "@/lib/cliUsage";
import { BrandIcon } from "@/lib/brandIcons";
import { openExternal } from "@/lib/openExternal";
import { ipc } from "@/lib/ipc";
import { toastError } from "@/lib/errors";
import { cn } from "@/lib/cn";
import type { CliAccount, CliRole, CliState, CliToolStatus, ConnectionProfile, ManagedToolId } from "@/lib/types";
import { Btn, Note, Status, type Tone } from "./settings/kit";
import { ManagedToolCard, toolOps, useManagedTool } from "./ManagedToolCard";

// The CLIs page (Plan 35): every command-line tool Faro uses, who is signed
// in, and which connections depend on it. Rendered as a page over the work
// area (rail, status pill, palette) and as Settings › CLIs.

export const CLI_ICON: Partial<Record<ManagedToolId, string>> = {
  cloudflared: "simple-icons:cloudflare",
  op: "simple-icons:1password",
  bw: "simple-icons:bitwarden",
  aws: "simple-icons:amazonwebservices",
  gcloud: "simple-icons:googlecloud",
  az: "simple-icons:microsoftazure",
  gh: "simple-icons:github",
  tailscale: "simple-icons:tailscale",
  doctl: "simple-icons:digitalocean",
  hcloud: "simple-icons:hetzner",
  render: "simple-icons:render",
  hs: "simple-icons:hubspot",
  shopify: "simple-icons:shopify",
};

const ROLE_LABEL: Record<CliRole, string> = {
  tunnel: "Tunnel",
  secrets: "Secrets",
  signIn: "Sign-in",
  discover: "Import",
};

const ROLE_HELP: Record<CliRole, string> = {
  tunnel: "Connections reach their server through it.",
  secrets: "Passwords and keys come from it.",
  signIn: "Connections sign in with its login: short-lived credentials, kept in memory only.",
  discover: "Find connections lists your servers, buckets or portals to import.",
};

export function stateTone(state: CliState | undefined): Tone {
  switch (state) {
    case "ready":
      return "ok";
    case "expired":
    case "signedOut":
      return "warn";
    case "error":
      return "bad";
    case "unknown":
      return "ok";
    default:
      return "off";
  }
}

/** Faro's three installable tools get the install card; the rest are found. */
const INSTALLABLE = new Set<ManagedToolId>(["cloudflared", "op", "bw"]);

export function CliIcon({ id, size = 16, className }: { id: ManagedToolId; size?: number; className?: string }) {
  const icon = CLI_ICON[id];
  return (
    <span className={cn("flex shrink-0 items-center justify-center text-text-muted", className)} style={{ width: size, height: size }}>
      {icon ? <BrandIcon icon={icon} size={size} /> : <TerminalSquare size={size} />}
    </span>
  );
}

interface Row {
  status: CliToolStatus;
  used: { profile: ConnectionProfile; uses: ToolUse[] }[];
  /** A problem some connection runs into. */
  blocking: boolean;
}

function rowsFor(order: ManagedToolId[], statuses: Record<string, CliToolStatus>, profiles: ConnectionProfile[]): Row[] {
  const usage = usageByTool(profiles);
  return order
    .map((id) => statuses[id])
    .filter(Boolean)
    .map((status) => {
      const used = usage.get(status.id) ?? [];
      const blocking = used.some(({ uses }) => uses.some((u) => isProblem(stateForUse(status, u))));
      return { status, used, blocking };
    });
}

/** Problems first, then the most used, then name; unused missing CLIs last. */
function sortRows(rows: Row[]): { main: Row[]; more: Row[] } {
  const main = rows
    .filter((r) => r.status.installed || r.used.length > 0)
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.used.length - a.used.length || a.status.name.localeCompare(b.status.name));
  const more = rows.filter((r) => !r.status.installed && r.used.length === 0).sort((a, b) => a.status.name.localeCompare(b.status.name));
  return { main, more };
}

export function CliHub({ onClose, embedded }: { onClose?: () => void; embedded?: boolean }) {
  const statuses = useClis((s) => s.statuses);
  const order = useClis((s) => s.order);
  const loaded = useClis((s) => s.loaded);
  const refresh = useClis((s) => s.refresh);
  const checkAll = useClis((s) => s.checkAll);
  const checking = useClis((s) => s.checking);
  const profiles = useConnections((s) => s.profiles);
  const preselect = useLayout((s) => s.cliSelect);
  const [selected, setSelected] = useState<ManagedToolId | null>(preselect);
  const [query, setQuery] = useState("");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Fresh account checks each time the page opens.
  useEffect(() => {
    void refresh().then(() => useClis.getState().checkAll());
  }, [refresh]);

  useEffect(() => {
    if (preselect) setSelected(preselect);
  }, [preselect]);

  // Escape closes the page (not the embedded Settings section).
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      onCloseRef.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded]);

  const rows = useMemo(() => rowsFor(order, statuses, profiles), [order, statuses, profiles]);
  const q = query.trim().toLowerCase();
  const filtered = q ? rows.filter((r) => `${r.status.name} ${r.status.id}`.toLowerCase().includes(q)) : rows;
  const { main, more } = sortRows(filtered);
  const current = rows.find((r) => r.status.id === selected) ?? main[0] ?? more[0];
  const ready = rows.filter((r) => r.status.state === "ready").length;
  const attention = rows.filter((r) => r.blocking).length;
  const anyChecking = Object.values(checking).some(Boolean);

  const body = (
    <div className="flex min-h-0 flex-1 gap-4">
      <div className="flex w-[19rem] shrink-0 flex-col">
        <label className="mb-2 flex h-7 items-center gap-1.5 rounded border border-border bg-bg-subtle px-2 text-[12px]">
          <Search size={12} className="text-text-dim" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter CLIs"
            aria-label="Filter CLIs"
            className="min-w-0 flex-1 bg-transparent outline-none"
          />
        </label>
        <div role="listbox" aria-label="CLIs" className="min-h-0 flex-1 overflow-y-auto rounded border border-border" data-testid="cli-list">
          {!loaded && <div className="px-3 py-6 text-center text-xs text-text-dim">Loading…</div>}
          {main.map((r) => (
            <CliRow key={r.status.id} row={r} active={current?.status.id === r.status.id} onSelect={() => setSelected(r.status.id)} busy={!!checking[r.status.id]} />
          ))}
          {more.length > 0 && (
            <>
              <div className="border-t border-border bg-bg-subtle px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-text-dim">More CLIs Faro can use</div>
              {more.map((r) => (
                <CliRow key={r.status.id} row={r} active={current?.status.id === r.status.id} onSelect={() => setSelected(r.status.id)} busy={false} />
              ))}
            </>
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto pr-1">{current && <CliDetail key={current.status.id} row={current} />}</div>
    </div>
  );

  if (embedded) {
    return (
      <div className="flex h-[30rem] flex-col gap-2" data-testid="cli-hub" data-settings-focus="clis">
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span className="flex-1">
            {ready} ready{attention > 0 ? ` · ${attention} need attention` : ""}
          </span>
          <Btn size="sm" variant="ghost" icon={<RefreshCw size={12} className={cn(anyChecking && "animate-spin")} />} onClick={() => void checkAll()} disabled={anyChecking}>
            Check all
          </Btn>
        </div>
        {body}
      </div>
    );
  }

  return (
    <div role="region" aria-label="CLIs" data-testid="cli-hub" className="absolute inset-0 z-[5] flex flex-col bg-bg px-5 pb-4 pt-4">
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
            <TerminalSquare size={16} className="text-text-dim" />
            CLIs
          </h1>
          <p className="mt-0.5 truncate text-[12px] text-text-muted" data-testid="cli-summary">
            {ready} ready{attention > 0 ? ` · ${attention} need${attention === 1 ? "s" : ""} attention` : ""} · the tools your connections tunnel, sign in and import through
          </p>
        </div>
        <Btn size="sm" icon={<RefreshCw size={12} className={cn(anyChecking && "animate-spin")} />} onClick={() => void checkAll()} disabled={anyChecking}>
          Check all
        </Btn>
        <button aria-label="Close CLIs" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-hover hover:text-text">
          <X size={15} />
        </button>
      </div>
      {body}
    </div>
  );
}

function CliRow({ row, active, onSelect, busy }: { row: Row; active: boolean; onSelect: () => void; busy: boolean }) {
  const s = row.status;
  return (
    <button
      role="option"
      aria-selected={active}
      data-cli={s.id}
      data-cli-state={s.state}
      onClick={onSelect}
      className={cn("flex w-full items-center gap-2.5 border-b border-border-subtle px-3 py-2 text-left last:border-b-0", active ? "bg-bg-hover" : "hover:bg-bg-hover/60")}
    >
      <CliIcon id={s.id} size={16} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-text">{s.name}</span>
        <span className="block truncate text-[11px] text-text-dim">
          {row.used.length > 0 ? `Used by ${row.used.length} connection${row.used.length === 1 ? "" : "s"}` : s.roles.map((r) => ROLE_LABEL[r]).join(" · ") || "Detected"}
        </span>
      </span>
      {busy ? <Status tone="busy">Checking</Status> : <Status tone={row.blocking ? "warn" : stateTone(s.state)}>{STATE_LABEL[s.state]}</Status>}
    </button>
  );
}

function CliDetail({ row }: { row: Row }) {
  const s = row.status;
  const check = useClis((st) => st.check);
  const signIn = useClis((st) => st.signIn);
  const busy = useClis((st) => !!st.checking[s.id]);
  const openEditProfile = useLayout((st) => st.openEditProfile);
  const openImportCli = useLayout((st) => st.openImportCli);
  const connect = useConnections((st) => st.connect);
  const canDiscover = s.roles.includes("discover");
  const canSignIn = s.roles.includes("signIn");
  const problem = isProblem(s.state);
  const discoverAccounts = s.accounts.length > 0 ? s.accounts : [];

  const pickOwn = async () => {
    const picked = await open({ multiple: false, directory: false, title: `Choose ${s.name}` });
    if (typeof picked !== "string") return;
    try {
      await ipc.toolSetCustomPath(s.id, picked);
      await useClis.getState().refresh();
      await check(s.id);
    } catch (e) {
      toastError(e, `Couldn't use that ${s.name}`);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="cli-detail" data-cli={s.id}>
      <div className="flex items-start gap-3">
        <CliIcon id={s.id} size={24} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">{s.name}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-text-dim">
            {s.roles.length > 0 ? (
              s.roles.map((r) => (
                <span key={r} title={ROLE_HELP[r]}>
                  {ROLE_LABEL[r]}
                </span>
              ))
            ) : (
              <span>Detected only</span>
            )}
            {s.docsUrl && (
              <button className="inline-flex items-center gap-0.5 text-accent hover:underline" onClick={() => openExternal(s.docsUrl)}>
                Docs <ExternalLink size={10} />
              </button>
            )}
          </div>
        </div>
        {busy ? <Status tone="busy">Checking</Status> : <Status tone={row.blocking ? "warn" : stateTone(s.state)}>{STATE_LABEL[s.state]}</Status>}
      </div>

      {s.detail && (
        <Note tone={problem ? "warning" : "dim"}>
          <span data-testid="cli-detail-text">{s.detail}</span>
        </Note>
      )}

      {/* Install */}
      <section className="rounded border border-border px-3 py-2">
        <h3 className="mb-1 text-xs font-semibold">Install</h3>
        {INSTALLABLE.has(s.id) ? (
          <InstallableCard id={s.id} name={s.name} />
        ) : s.installed ? (
          <div className="flex items-center gap-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate text-text-muted" title={s.path}>
              {s.version ?? "unknown version"} · <span className="font-mono text-[11px]">{s.path}</span>
            </span>
            <Btn size="sm" variant="ghost" icon={<FolderOpen size={12} />} onClick={() => void pickOwn()}>
              Use another copy…
            </Btn>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[12px]">
            <span className="flex-1 text-text-muted">Faro doesn't install {s.name}; it finds it once you have.</span>
            {s.installUrl && (
              <Btn size="sm" variant="primary" icon={<ExternalLink size={12} />} onClick={() => openExternal(s.installUrl!)}>
                Get it
              </Btn>
            )}
            <Btn size="sm" variant="ghost" icon={<FolderOpen size={12} />} onClick={() => void pickOwn()}>
              Use my own copy…
            </Btn>
          </div>
        )}
      </section>

      {/* Accounts */}
      {s.installed && s.hasAccount && (
        <section className="rounded border border-border px-3 py-2" data-testid="cli-accounts">
          <div className="mb-1 flex items-center gap-1.5">
            <h3 className="text-xs font-semibold">Accounts</h3>
            <div className="ml-auto flex items-center gap-1.5">
              <Btn size="sm" variant="ghost" icon={<RefreshCw size={12} className={cn(busy && "animate-spin")} />} onClick={() => void check(s.id)} disabled={busy}>
                Check
              </Btn>
              {s.signIn && (
                <Btn size="sm" variant={problem ? "primary" : "default"} icon={<LogIn size={12} />} onClick={() => void signIn(s.id)} title={`Runs \`${s.signIn}\` in a new window`} data-testid="cli-sign-in">
                  Sign in
                </Btn>
              )}
            </div>
          </div>
          {s.accounts.length === 0 ? (
            <p className="py-1 text-[12px] text-text-dim">{s.checkedAt ? "No accounts signed in." : "Not checked yet."}</p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {s.accounts.map((a) => (
                <AccountRow key={a.id} cli={s} account={a} canSignIn={canSignIn} canDiscover={canDiscover} onFind={() => openImportCli(s.id, a.id)} />
              ))}
            </ul>
          )}
          {canSignIn && (
            <p className="mt-1.5 text-[11px] text-text-dim">
              Allowed accounts lend their login to connections set to sign in with {s.name}: Faro asks the CLI for a short-lived credential at connect time and keeps it in memory only.
            </p>
          )}
        </section>
      )}

      {/* Import from a CLI with no per-account list (gcloud's active account etc.) */}
      {s.installed && canDiscover && discoverAccounts.length === 0 && s.state === "ready" && (
        <Btn size="sm" onClick={() => openImportCli(s.id)}>
          Find connections…
        </Btn>
      )}

      {/* Connections */}
      <section className="rounded border border-border px-3 py-2" data-testid="cli-connections">
        <h3 className="mb-1 text-xs font-semibold">
          Connections <span className="font-normal text-text-dim">· {row.used.length}</span>
        </h3>
        {row.used.length === 0 ? (
          <p className="py-1 text-[12px] text-text-dim">No connection uses {s.name}.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {row.used.map(({ profile, uses }) => {
              const bad = uses.find((u) => isProblem(stateForUse(s, u)));
              return (
                <li key={profile.id}>
                  <button
                    data-cli-connection={profile.id}
                    onClick={() => openEditProfile(profile.id)}
                    onDoubleClick={() => void connect(profile.id).catch(() => {})}
                    title="Open the connection · double-click to connect"
                    className="flex w-full items-center gap-2 py-1.5 text-left text-[12.5px] hover:text-accent"
                  >
                    <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                    <span className="shrink-0 text-[11px] text-text-dim">
                      {uses.map((u) => `${HOW_LABEL[u.how]}${u.account && u.account !== "default" ? ` · ${u.account}` : ""}${u.via ? ` (via ${u.via})` : ""}`).join(", ")}
                    </span>
                    {bad && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-label="Needs attention" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function InstallableCard({ id, name }: { id: ManagedToolId; name: string }) {
  const tool = useManagedTool(toolOps(id), name, id, () => void useClis.getState().refresh());
  return <ManagedToolCard tool={tool} name={name} compact testId={`cli-install-${id}`} />;
}

function AccountRow({
  cli,
  account: a,
  canSignIn,
  canDiscover,
  onFind,
}: {
  cli: CliToolStatus;
  account: CliAccount;
  canSignIn: boolean;
  canDiscover: boolean;
  onFind: () => void;
}) {
  const setAllowed = useClis((st) => st.setAllowed);
  const signIn = useClis((st) => st.signIn);
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-[12.5px]" data-cli-account={a.id}>
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {a.label}
          {a.active && <span className="ml-1.5 text-[11px] text-text-dim">default</span>}
        </span>
        {a.detail && <span className="block truncate text-[11px] text-warning">{a.detail}</span>}
      </span>
      <Status tone={stateTone(a.state)}>{STATE_LABEL[a.state]}</Status>
      {isProblem(a.state) && cli.id === "aws" && (
        <Btn size="sm" variant="ghost" icon={<LogIn size={12} />} onClick={() => void signIn(cli.id, a.id)}>
          Sign in
        </Btn>
      )}
      {canDiscover && a.state === "ready" && (
        <Btn size="sm" variant="ghost" onClick={onFind} data-testid="cli-find">
          Find connections…
        </Btn>
      )}
      {canSignIn && (
        <Btn
          size="sm"
          variant={a.allowed ? "ghost" : "default"}
          onClick={() => void setAllowed(cli.id, a.id, !a.allowed)}
          data-testid="cli-allow"
          aria-pressed={!!a.allowed}
          title={a.allowed ? `Stop Faro using this ${cli.name} login` : `Let connections sign in with this ${cli.name} login`}
        >
          {a.allowed ? "Revoke" : "Allow"}
        </Btn>
      )}
    </li>
  );
}

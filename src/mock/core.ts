// Mock of @tauri-apps/api/core `invoke` for the demo build. Returns fictional
// data so the whole UI renders populated without the Rust backend. Unhandled
// commands resolve to null, which is harmless for the screens we capture.
import * as data from "./data";
import * as vfs from "./vfs";
import * as transfers from "./transfers";
import * as sysmon from "./sysmon";
import * as docker from "./docker";
import { emit } from "./event";

type Args = Record<string, any>;

// Each open_terminal call gets a distinct id so split panes each render their
// own transcript (Plan 11). The registry opens one PTY per pane.
let terminalCounter = 0;
// Terminals that have received input (see terminal_write).
const echoed = new Set<string>();

// A tiny in-memory snippets store so the demo's Snippets panel / palette work
// (save/delete round-trip) without the Rust backend (Plan 11 Phase 4).
let snippets: any[] = [
  {
    id: "sn-tail",
    name: "Tail nginx errors",
    body: "sudo tail -n 100 -f /var/log/nginx/error.log",
    folder: "nginx",
    useCount: 6,
    createdMs: 0,
    updatedMs: 0,
  },
  {
    id: "sn-wp",
    name: "WP core update",
    body: "wp core update --path=/var/www/{{site}}",
    folder: "wordpress",
    useCount: 3,
    createdMs: 0,
    updatedMs: 0,
  },
  {
    id: "sn-restart",
    name: "Restart service",
    body: "sudo systemctl restart {{service}}",
    folder: null,
    useCount: 1,
    createdMs: 0,
    updatedMs: 0,
  },
];

// Mock PATH-integration state (Plan 16 Phase 4). `managed` flips on add/remove so
// the About tab's Add ⇄ Remove flow round-trips without the Rust backend.
let pathManaged = false;
let groupGateways: Record<string, string> = {};
function pathStatus() {
  return {
    binDir: "C:\\Users\\demo\\AppData\\Roaming\\com.juandenis.faro\\bin",
    binHasCli: true,
    onPath: pathManaged,
    cliLocation: pathManaged
      ? "C:\\Users\\demo\\AppData\\Roaming\\com.juandenis.faro\\bin\\faro-cli.exe"
      : null,
    managed: pathManaged,
    detail: null as string | null,
  };
}

// Settings › Storage demo sizes. Clearing zeroes one until the page reloads.
const mockCaches: Record<string, { bytes: number; items: number }> = {
  thumbnails: { bytes: 48_734_208, items: 1_204 },
  transferResume: { bytes: 734_003_200, items: 2 },
  editCopies: { bytes: 2_621_440, items: 3 },
};

// Demo Access forwards. postgres and admin start listening; redis reports a
// port conflict so the rail can show that state.
const cfForwardRunning = new Set<string>(["p-cf\0postgres", "p-cf\0admin"]);
const cfForwardErrors: Record<string, string> = {
  "p-cf\0redis": "local port 6379 is already in use",
};

function cfForwardRows() {
  const profile = data.profiles.find((p) => p.id === "p-cf");
  return (profile?.cfForwards ?? []).map((f) => {
    const key = `p-cf\0${f.name}`;
    return {
      profileId: "p-cf",
      profileName: profile?.name ?? "edge-access",
      name: f.name,
      hostname: f.hostname ?? "",
      localPort: f.localPort,
      web: !!f.web,
      running: cfForwardRunning.has(key),
      error: cfForwardErrors[key],
    };
  });
}

export async function invoke<T = unknown>(cmd: string, args: Args = {}): Promise<T> {
  const out = await dispatch(cmd, args);
  return out as T;
}

async function dispatch(cmd: string, a: Args): Promise<unknown> {
  // Server view (Plan 30) lives in its own module.
  if (cmd.startsWith("sysmon_")) return sysmon.handle(cmd, a) ?? null;
  // Docker manager and live logs (Plan 31) too.
  if (cmd.startsWith("docker_") || cmd === "follow_stop") return docker.handle(cmd, a) ?? null;
  switch (cmd) {
    case "app_release_notes_since": {
      // Plan 32: a JSON list in sessionStorage stands in for GitHub; none = offline.
      const list = sessionStorage.getItem("faro-mock-releases");
      if (!list) throw { message: "Couldn't reach GitHub.", detail: "mock offline" };
      return JSON.parse(list);
    }
    case "app_update_release": {
      const w = window as any;
      if (w.__mockReleaseError) throw w.__mockReleaseError;
      return w.__mockRelease ?? { version: "1.3.49", currentVersion: "1.3.43", notes: "Fixes and improvements.",
        newer: true, url: "https://github.com/jhd3197/Faro/releases/tag/v1.3.49" };
    }
    // ---- profiles ----
    case "folder_sync_conflicts": return [];
    case "folder_sync_resolve": return null;
    case "credential_providers": return [];
    case "group_gateways": return groupGateways;
    case "set_group_gateway": { if (a.gateway) groupGateways[a.group] = a.gateway; else delete groupGateways[a.group]; return null; }
    case "organize_profiles": {
      const changes = a.changes as { id: string; group?: string; sortOrder?: number }[];
      const before = changes.map(c => {
        const p = data.profiles.find(p => p.id === c.id);
        if (!p) throw new Error("Profile was removed");
        return { id: p.id, group: p.group, sortOrder: p.sortOrder };
      });
      for (const old of (a.expected ?? [])) {
        const p = data.profiles.find(p => p.id === old.id);
        if (!p || (p.group ?? null) !== (old.group ?? null) || (p.sortOrder ?? null) !== (old.sortOrder ?? null)) throw new Error("Organization changed since this action");
      }
      data.setProfiles(data.profiles.map(p => { const change = changes.find(c => c.id === p.id); return change ? { ...p, group: change.group, sortOrder: change.sortOrder } : p; }));
      return before;
    }
    case "list_profiles":
      // A fresh install (Plan 32 harness) has no saved connections yet.
      if (sessionStorage.getItem("faro-mock-fresh") === "1") return [];
      return data.profiles;
    case "save_profile": {
      const p = a.profile;
      const i = data.profiles.findIndex((x) => x.id === p.id);
      data.setProfiles(
        i >= 0
          ? data.profiles.map((x) => (x.id === p.id ? p : x))
          : [...data.profiles, p]
      );
      return null;
    }
    case "delete_profile":
      data.setProfiles(data.profiles.filter((x) => x.id !== a.id));
      return null;
    case "reorder_profiles": {
      const order = a.ids as string[];
      data.setProfiles(
        data.profiles.map((p) => {
          const i = order.indexOf(p.id);
          return i >= 0 ? { ...p, sortOrder: i } : p;
        })
      );
      return null;
    }

    // ---- settings + credentials (Plan 12) ----
    case "settings_get_all":
      return JSON.parse(sessionStorage.getItem("faro-mock-discovery") ?? '{"discoverySeenVersion":"1.3.22"}');
    case "settings_set": {
      // Rows the demo keeps across reloads (in this tab): discovery state and
      // the restored-session/window rows the restore test reads back.
      if (String(a.key).startsWith("discovery") || ["sessionSnapshot", "windowBackground", "palette.recent"].includes(String(a.key))) {
        const settings = JSON.parse(sessionStorage.getItem("faro-mock-discovery") ?? '{"discoverySeenVersion":"1.3.22"}');
        settings[a.key] = a.value;
        sessionStorage.setItem("faro-mock-discovery", JSON.stringify(settings));
      }
      return null;
    }
    case "settings_delete":
    case "settings_set_all":
    case "set_api_key":
    case "set_profile_password_keychain":
      return null;
    case "profile_keychain_warnings":
      return [];
    case "api_key_status":
      return false;
    case "oauth_builtin_apps":
      return { dropbox: false, onedrive: false, gdrive: false, box: false };
    case "dropbox_authorize":
    case "onedrive_authorize":
    case "gdrive_authorize":
    case "box_authorize":
      if (!a.clientId) {
        throw "this Faro build has no built-in app for this provider";
      }
      return { accountLabel: "demo@example.com" };

    // ---- sessions ----
    case "connect":
      // Test hooks (Plan 12 Phase 3): sentinel ids reject like a migrated
      // command — a structured {kind, message} error, exactly as Tauri delivers
      // one. Drives scripts/verify-errors.mjs.
      if (a.profileId === "__auth_fail__")
        throw { kind: "auth", message: "Authentication failed for user demo" };
      if (a.profileId === "__net_fail__")
        throw { kind: "network", message: "Connection refused (os error 111)" };
      if (a.profileId === "__str_fail__")
        throw "legacy string error: something broke"; // un-migrated command shape
      {
        // Issue #86 test hooks for Cloudflare profiles: `window.__cfConnect`
        // = "hostkey" asks about an unknown host key first; "refused" fails
        // the way ssh_cert words a certificate the server turned down.
        const w = window as unknown as { __cfConnect?: string; __hostAnswer?: (d: string) => void };
        const p = data.profiles.find((x) => x.id === a.profileId);
        if (p?.proxyCommand?.kind === "cloudflare" && w.__cfConnect) {
          await new Promise((r) => setTimeout(r, 400));
          if (w.__cfConnect === "hostkey") {
            const decision = await new Promise<string>((resolve) => {
              w.__hostAnswer = resolve;
              emit("host://prompt", {
                requestId: "mock-host",
                host: p.proxyCommand?.hostname || p.host,
                port: p.port,
                keyType: "ssh-ed25519",
                fingerprint: "SHA256:k3Vq0Yb1u9mN2xR7pLzW4eTjH8sQdFcA6oIvGy5BnKs",
                kind: "unknown",
              });
            });
            if (decision === "reject") throw { kind: "other", message: "Host key rejected" };
          }
          if (w.__cfConnect === "refused")
            throw {
              kind: "auth",
              message: `Cloudflare issued a certificate for \`jane.doe\`, but the server refused it for user \`${p.username}\`.`,
            };
        }
      }
      return data.openSession(a.profileId);
    case "disconnect":
      data.closeSession(a.sessionId);
      return null;
    case "respond_to_host_prompt":
      (window as unknown as { __hostAnswer?: (d: string) => void }).__hostAnswer?.(String(a.decision));
      return null;

    // ---- files ----
    case "list_directory":
      return vfs.list(a.sessionId, a.path);
    case "browse_directory":
      return { entries: vfs.list(a.sessionId, a.path), skippedEntries: 0 };
    case "capabilities":
      return data.capabilities(a.sessionId);
    case "read_file_preview":
      throw new Error("no preview in demo mode");
    case "read_file_head":
      return btoa(
        Array.from({ length: 40 }, (_, i) =>
          `22:41:${String(i).padStart(2, "0")}  step ${i + 1} ok`
        ).join(String.fromCharCode(10))
      );
    case "preview_thumbnail":
      // A valid 8×8 RGBA PNG so the mock harness can exercise the remote-preview
      // UI (toggle → thumbnail render → downscale) without a real backend.
      return "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAANElEQVR42n3EQQEAEAAEwY0jhBDe3kIIIYQQQmjFJdjHDKXfZ6jJ0JJhJMNMhpUMOxlOMh/OWKPBK+ZUdQAAAABJRU5ErkJggg==";
    case "cache_usage":
      return Object.entries(mockCaches).map(([id, c]) => ({ id, ...c }));
    case "cache_clear": {
      const c = mockCaches[String(a.id)];
      if (!c) throw new Error(`unknown cache ${a.id}`);
      c.bytes = 0;
      c.items = 0;
      return { id: a.id, ...c };
    }
    case "rename_path":
      return vfs.rename(a.sessionId, a.from, a.to), null;
    case "delete_path":
      return vfs.remove(a.sessionId, a.path), null;
    case "create_directory":
      return vfs.mkdir(a.sessionId, a.path), null;
    case "duplicate_path":
      return vfs.duplicate(a.sessionId, a.path), null;
    case "copy_path":
      return vfs.copy(a.sessionId, a.from, a.to), null;
    case "chmod_path":
      return null;
    case "start_archive_download":
      return "t-archive";

    // ---- terminal ----
    case "open_terminal": {
      const id = `term-${++terminalCounter}`;
      // Push the canned transcript once the xterm is listening.
      setTimeout(
        () => emit("terminal://data", { terminalId: id, data: data.TERMINAL_TRANSCRIPT }),
        120
      );
      return id;
    }
    case "terminal_write": {
      // Echo keystrokes like a real PTY so typed commands and inserted
      // snippets show up. The first write backs over the transcript's
      // painted cursor; Enter starts a fresh prompt.
      let out = echoed.has(a.terminalId) ? "" : "\b";
      echoed.add(a.terminalId);
      for (const ch of String(a.data)) {
        if (ch === "\r") out += "\r\n" + data.TERMINAL_PROMPT;
        else if (ch === "\x7f") out += "\b \b";
        else if (ch >= " " || ch === "\t") out += ch;
      }
      emit("terminal://data", { terminalId: a.terminalId, data: out });
      return null;
    }
    case "terminal_resize":
    case "close_terminal":
      return null;

    // ---- snippets (Plan 11 Phase 4) ----
    case "snippet_list":
      return snippets;
    case "snippet_save": {
      const s = a.snippet;
      const i = snippets.findIndex((x) => x.id === s.id);
      snippets = i >= 0 ? snippets.map((x) => (x.id === s.id ? s : x)) : [...snippets, s];
      return snippets;
    }
    case "snippet_delete":
      snippets = snippets.filter((x) => x.id !== a.id);
      return snippets;
    case "snippet_run": {
      snippets = snippets.map((x) =>
        x.id === a.id ? { ...x, useCount: x.useCount + 1 } : x
      );
      return snippets;
    }

    // ---- transfers ----
    case "list_transfers":
      return transfers.listTransfers();
    case "transfer_forget_finished":
      return;
    case "start_download": {
      const dir = a.remotePath.replace(/\/[^/]*$/, "") || "/";
      const name = a.remotePath.split("/").pop();
      const size = data.listDir(a.sessionId, dir).find((e) => e.name === name)?.size;
      return transfers.start("download", a.remotePath, a.localDir, size);
    }
    case "start_upload":
      return transfers.start("upload", a.localPath, a.remoteDir);
    case "inspect_upload_paths":
      // What an upload would send: one entry per picked path (a name with an
      // extension is a file, anything else a folder).
      return (a.paths as string[]).map((p) => {
        const dir = !/\.[^\\/.]+$/.test(p);
        return { path: p, kind: dir ? "directory" : "file", files: dir ? 0 : 1, directories: dir ? 1 : 0, directoryPaths: [], fingerprint: `mock:${p}`, size: dir ? 0 : 1204 };
      });
    case "start_archive":
      return "t-new";
    case "start_directory_download":
    case "start_directory_upload":
      return ["t-new"];
    case "cancel_transfer":
      return null;

    // ---- transfer queue (Plan 17) ----
    case "transfer_pause":
    case "transfer_resume":
    case "transfer_retry":
    case "transfer_move":
    case "transfer_pause_all":
    case "transfer_resume_all":
    case "transfer_set_concurrency":
    case "transfer_set_throttle":
    case "transfer_set_delta_sync":
    case "transfer_set_segments":
    case "transfer_set_verify":
      transfers.handle(cmd, a);
      return null;
    case "transfer_queue_state":
      return transfers.queueState();

    // ---- importers ----
    case "importer_default_paths":
      return sessionStorage.getItem("faro-mock-found") === "1"
        ? { openssh: "C:\\Users\\demo\\.ssh\\config", filezilla: "C:\\Users\\demo\\AppData\\Roaming\\FileZilla\\sitemanager.xml", putty: "HKCU\\Software\\SimonTatham\\PuTTY\\Sessions", opensshExists: true, filezillaExists: true }
        : { openssh: "~/.ssh/config", filezilla: null, putty: null, opensshExists: true, filezillaExists: false };
    case "import_openssh":
    case "import_filezilla":
    case "import_putty": {
      if (sessionStorage.getItem("faro-mock-found") !== "1") return [];
      const hosts: Record<string, string[]> = {
        import_openssh: ["web-1", "web-2", "db-primary", "bastion", "staging", "build-runner", "grafana", "backup-nas"],
        import_filezilla: ["shared-host", "client-ftp", "old-cpanel"],
        import_putty: [],
      };
      return hosts[cmd].map((name, i) => ({ previewId: `${cmd}-${i}`, name, protocol: cmd === "import_filezilla" ? "ftp" : "sftp",
        host: `${name}.example.net`, port: cmd === "import_filezilla" ? 21 : 22, username: "deploy" }));
    }
    case "save_imported_profiles":
      return 0;
    case "cf_account_status":
      return { connected: false, choices: [], permissions: [] };
    case "cf_forwards_status":
      return cfForwardRows();
    case "cf_forward_start": {
      const row = cfForwardRows().find((r) => r.profileId === a.profileId && r.name === a.name);
      if (row?.name === "redis") {
        cfForwardErrors[`${a.profileId}\0${a.name}`] = "local port 6379 is already in use";
        throw new Error("local port 6379 is already in use");
      }
      if (row) cfForwardRunning.add(`${a.profileId}\0${a.name}`);
      delete cfForwardErrors[`${a.profileId}\0${a.name}`];
      return row ? { ...row, running: true, error: undefined } : null;
    }
    case "cf_forward_stop":
      cfForwardRunning.delete(`${a.profileId}\0${a.name}`);
      return null;
    case "cf_forward_open":
      (window as unknown as { __cfOpened?: string }).__cfOpened = `http://127.0.0.1:${
        cfForwardRows().find((r) => r.profileId === a.profileId && r.name === a.name)?.localPort ?? 0
      }/`;
      cfForwardRunning.add(`${a.profileId}\0${a.name}`);
      return null;
    case "cloudflared_status":
    case "cloudflared_check":
      return {
        source: "path",
        path: "/usr/bin/cloudflared",
        version: "2026.1.0",
        latest: "2026.1.0",
        updateAvailable: false,
      };
    case "agent_host_status":
    case "agent_host_set_enabled":
    case "agent_host_open_pairing":
    case "agent_host_close_pairing":
    case "agent_host_set_policy":
    case "agent_host_revoke_peer":
      return {
        enabled: true,
        running: true,
        port: 8722,
        hostname: "this-computer",
        os: "linux",
        fingerprint: "SHA256:demo",
        allowExec: false,
        allowWrite: false,
        peers: [],
        pairing: null,
      };
    case "cf_account_hostnames":
      return [
        {
          hostname: "ssh.edge.example.com",
          label: "tunnel edge",
          tunnelId: "tun_edge",
          tunnelStatus: "healthy",
          connectorLastSeen: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
          connectorVersion: "2026.8.2",
          appId: "app_edge",
        },
      ];
    case "cf_account_zones":
      return [];
    case "cf_access_login":
      // The browser round-trip: a moment, then signed in.
      await new Promise((r) => setTimeout(r, 1200));
      (window as unknown as { __cfAccess?: string }).__cfAccess = "loggedIn";
      return { hostname: a.hostname, state: "loggedIn", identity: "jane.doe@example.com", expiresAt: Math.floor(Date.now() / 1000) + 18 * 3600 };
    case "cf_access_status": {
      // `window.__cfAccess` picks the state for screenshots (default: signed in).
      const state = (window as unknown as { __cfAccess?: string }).__cfAccess ?? "loggedIn";
      return state === "loggedIn"
        ? { hostname: a.hostname, state, identity: "jane.doe@example.com", expiresAt: Math.floor(Date.now() / 1000) + 18 * 3600 }
        : { hostname: a.hostname, state };
    }
    case "import_faro_file":
      // A canned team file: one duplicate of a demo server, one that needs a key.
      return {
        encrypted: false,
        secrets: false,
        previews: [
          { previewId: "f1", name: "Bastion", protocol: "sftp", host: "bastion.demo.dev", port: 22, username: "ops", note: "group: Prod" },
          { previewId: "f2", name: "App server", protocol: "sftp", host: "app.internal", port: 22, username: "deploy", identityFile: "~/.ssh/team_ed25519", needs: ["key"], jumpPreviewId: "f1", jumpName: "Bastion", note: "group: Prod" },
        ],
      };
    case "export_connections":
      return { connections: (a.ids as string[] | undefined)?.length ?? 0, addedJumps: [], skipped: [] };

    // ---- access grants (faro://grant) ----
    // A canned two-server manifest so the consent dialog renders end-to-end
    // in the demo; accepting "imports" them into a rail group.
    case "fetch_grant_manifest":
      return {
        version: 1,
        issuer: "ServerKit · panel.demo.dev",
        name: "Client X — 2 servers",
        group: "Agency / Client X",
        expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
        auth: { type: "key-install" },
        connections: [
          {
            name: "web-1",
            protocol: "sftp",
            host: "10.0.0.11",
            port: 22,
            username: "deploy",
            path: "/var/www",
            jump: { host: "bastion.demo.dev", port: 22, username: "faro-grant" },
          },
          {
            name: "db-1",
            protocol: "sftp",
            host: "10.0.0.12",
            port: 22,
            username: "deploy",
          },
        ],
      };
    case "accept_grant": {
      const manifest = a.manifest;
      const imported = (manifest?.connections ?? []).map(
        (c: any, i: number) => ({
          id: `grant-${i}`,
          name: c.name || c.host,
          protocol: "sftp",
          host: c.host,
          port: c.port ?? 22,
          username: c.username,
          auth: { kind: "keyref", keyRef: `grant-key:grant-${i}` },
          defaultRemotePath: c.path,
          group: manifest?.group ?? manifest?.issuer,
          jumpHost: c.jump?.host,
          jumpPort: c.jump?.port,
          jumpUsername: c.jump?.username,
        })
      );
      data.setProfiles([...data.profiles, ...imported]);
      return {
        group: manifest?.group ?? "Grants",
        imported,
        failed: [],
        fingerprint: "SHA256:mockmockmockmockmockmockmockmockmockmockmo",
        pendingApproval: false,
      };
    }

    // ---- sync ----
    case "diagnose_connection": {
      // `window.__diag = "auth"` makes the check fail at sign-in (screenshots).
      const diag = (window as unknown as { __diag?: string }).__diag;
      await new Promise((r) => setTimeout(r, diag ? 900 : 0));
      if (diag === "auth")
        return {
          ok: false,
          steps: [
            { label: "Gateway configuration", ok: true, detail: "Passed", elapsedMs: 0 },
            { label: "First-hop DNS", ok: true, detail: "Passed", elapsedMs: 18 },
            { label: "First-hop TCP", ok: true, detail: "Passed", elapsedMs: 64 },
            {
              label: "Destination connection and sign-in",
              ok: false,
              detail: "Sign-in failed. Check the username, credential source, key, and any required second factor.",
              elapsedMs: 1412,
            },
          ],
        };
      return { ok: true, steps: [{ label: "Destination connection and sign-in", ok: true, detail: "Passed", elapsedMs: 120 }, { label: "Starting folder access", ok: true, detail: "Passed", elapsedMs: 40 }] };
    }
    case "sync_plan":
      return data.syncPlan(a.localPath, a.remotePath);
    case "sync_recovery_list":
      return [];
    case "sync_recovery_restore":
      return `${a.root}/${a.entry.relative}`;
    case "sync_execute":
      return ["t-sync"];

    // ---- continuous folder sync ----
    // The backend returns the full pair list from every mutation; mirror that
    // with an empty list so the status-bar pill and Sync settings render. (An
    // unhandled command would resolve to null and crash StatusBar's `.filter`.)
    case "foldersync_list":
    case "foldersync_upsert":
    case "foldersync_remove":
    case "foldersync_set_enabled":
    case "foldersync_sync_now":
      return [];

    // ---- disk usage ----
    // The scan finishes instantly with a canned tree: diskScanStart returns an
    // id, and the store immediately reads diskScanTree, which reports "done".
    case "diskscan_start":
      return "scan-1";
    case "diskscan_tree":
      return data.diskScanSnapshot;
    case "diskscan_cancel":
    case "diskscan_forget":
      return null;

    // ---- edit-in-place ----
    case "start_edit":
      return {
        editId: "e1",
        sessionId: a.sessionId,
        remotePath: a.remotePath,
        localTempPath: "C:\\Users\\demo\\AppData\\Local\\Temp\\faro-edits\\server.js",
      };
    case "stop_edit":
      return null;

    // ---- agent bridge ----
    case "bridge_status":
    case "bridge_start":
    case "bridge_stop":
    case "bridge_set_enabled":
    case "bridge_set_session_access":
    case "bridge_set_policy":
    case "bridge_register_mcp":
      return data.bridgeStatus;
    case "bridge_set_profile_access": {
      const st = data.bridgeStatus;
      const acc = a.access as import("@/lib/types").ProfileAccess;
      const on = [acc.read, acc.write, acc.exec].some((l) => l !== "off");
      if (on) st.profileAccess[a.profileId] = acc;
      else delete st.profileAccess[a.profileId];
      st.enabledProfiles = on
        ? Array.from(new Set([...st.enabledProfiles, a.profileId]))
        : st.enabledProfiles.filter((id) => id !== a.profileId);
      return { ...st };
    }
    case "bridge_activity":
      return data.bridgeActivity;
    case "bridge_clear_activity":
      return null;
    case "bridge_list_commands":
    case "bridge_save_command":
    case "bridge_delete_command":
      return data.savedCommands;
    case "bridge_set_active_session":
      return null;
    case "export_agent_log":
      return "C:\\Users\\demo\\Downloads\\faro-agent-console.txt";


    // ---- one-click PATH install (Plan 16 Phase 4) ----
    case "path_status":
      return pathStatus();
    case "path_add":
      pathManaged = true;
      return { ...pathStatus(), detail: "Added to your account's PATH." };
    case "path_remove":
      pathManaged = false;
      return { ...pathStatus(), detail: "Removed from your account's PATH." };

    default:
      return null;
  }
}

// Mock of @tauri-apps/api/core `invoke` for the demo build. Returns fictional
// data so the whole UI renders populated without the Rust backend. Unhandled
// commands resolve to null, which is harmless for the screens we capture.
import * as data from "./data";
import * as transfers from "./transfers";
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

export async function invoke<T = unknown>(cmd: string, args: Args = {}): Promise<T> {
  const out = await dispatch(cmd, args);
  return out as T;
}

async function dispatch(cmd: string, a: Args): Promise<unknown> {
  switch (cmd) {
    // ---- profiles ----
    case "list_profiles":
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
      return {};
    case "settings_set":
    case "settings_delete":
    case "settings_set_all":
    case "set_api_key":
      return null;
    case "api_key_status":
      return false;

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
      return data.openSession(a.profileId);
    case "disconnect":
      data.closeSession(a.sessionId);
      return null;

    // ---- files ----
    case "list_directory":
      return data.listDir(a.sessionId, a.path);
    case "capabilities":
      return data.capabilities(a.sessionId);
    case "read_file_preview":
      throw new Error("no preview in demo mode");
    case "preview_thumbnail":
      // A valid 8×8 RGBA PNG so the mock harness can exercise the remote-preview
      // UI (toggle → thumbnail render → downscale) without a real backend.
      return "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAANElEQVR42n3EQQEAEAAEwY0jhBDe3kIIIYQQQmjFJdjHDKXfZ6jJ0JJhJMNMhpUMOxlOMh/OWKPBK+ZUdQAAAABJRU5ErkJggg==";
    case "rename_path":
    case "delete_path":
    case "create_directory":
    case "chmod_path":
    case "duplicate_path":
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
    case "start_download": {
      const dir = a.remotePath.replace(/\/[^/]*$/, "") || "/";
      const name = a.remotePath.split("/").pop();
      const size = data.listDir(a.sessionId, dir).find((e) => e.name === name)?.size;
      return transfers.start("download", a.remotePath, a.localDir, size);
    }
    case "start_upload":
      return transfers.start("upload", a.localPath, a.remoteDir);
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
      transfers.handle(cmd, a);
      return null;
    case "transfer_queue_state":
      return transfers.queueState();

    // ---- importers ----
    case "importer_default_paths":
      return { openssh: "~/.ssh/config", filezilla: null, putty: null };
    case "import_openssh":
    case "import_filezilla":
    case "import_putty":
      return [];
    case "save_imported_profiles":
      return 0;

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
      return { group: manifest?.group ?? "Grants", imported, failed: [] };
    }

    // ---- sync ----
    case "sync_plan":
      return data.syncPlan(a.localPath, a.remotePath);
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
    case "diskscan_status":
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

    // ---- folder sync (no pairs in the demo) ----
    case "foldersync_list":
      return [];

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

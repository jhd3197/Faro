// Demo bootstrap: exposes the zustand stores on `window.__demo` so the headless
// screenshot script (scripts/capture-screenshots.mjs) can drive the UI into each
// state — open dialogs, switch sessions, expand the rail, etc. Loaded only when
// VITE_MOCK is set (see main.tsx).
import { useLayout } from "@/stores/layoutStore";
import { useConnections } from "@/stores/connectionsStore";
import { useTransfers } from "@/stores/transfersStore";
import { useBridge } from "@/stores/bridgeStore";
import { useTerminals } from "@/stores/terminalsStore";
import { useSettings } from "@/stores/settingsStore";
import { useDiskScan } from "@/stores/diskScanStore";
import { useServerView } from "@/stores/serverViewStore";
import { useDocker } from "@/stores/dockerStore";
import { useSnippets } from "@/stores/snippetsStore";
import { useToasts } from "@/stores/toastStore";
import { useBindings } from "@/stores/bindingsStore";
import { useSync } from "@/stores/syncStore";
import { useUpdater } from "@/stores/updaterStore";
import { useDiscovery } from "@/stores/discoveryStore";
import { useTips } from "@/stores/tipsStore";
import { useSites } from "@/stores/sitesStore";
import { useSession } from "@/stores/sessionStore";
import { useEditor } from "@/stores/editorStore";
import { usePalette } from "@/stores/paletteStore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "./event";
import { useCfConnect } from "@/components/CloudflareConnectSheet";
import { seed as seedTransfers, calls as transferCalls } from "./transfers";
import { calls as sysmonCalls, setProbe as setSysmonProbe } from "./sysmon";
import { calls as dockerCalls, setAccess as setDockerAccess, reset as resetDocker } from "./docker";

(window as any).__demo = {
  useLayout,
  useConnections,
  useTransfers,
  useBridge,
  useTerminals,
  useSettings,
  useDiskScan,
  useServerView,
  useDocker,
  useSnippets,
  useToasts,
  useBindings,
  useSync,
  useUpdater,
  useDiscovery,
  useTips,
  useSites,
  // Restored session (split, last server, Settings section) and open edits.
  useSession,
  useEditor,
  // Palette recent commands.
  usePalette,
  // Ask the window to close, as the title bar's close button does.
  requestClose: () => getCurrentWindow().close(),
  // Convenience: focus a server by profile id (connects if needed).
  focusProfile: (profileId: string) =>
    useConnections.getState().connect(profileId),
  // Issue #86: the Cloudflare link flow's store (start / connect / close).
  useCfConnect,
  // Push a mock Tauri event (e.g. a bridge://approval) for screenshots.
  emit,
  // Plan 17 test hooks: replace the mock transfer world (the store re-reads
  // via loadInitial) and inspect the transfer commands the UI invoked.
  seedTransfers,
  transferCalls,
  // Plan 30 test hooks: what the Server view asked the backend for, and a way
  // to make the next probe describe a different host.
  sysmonCalls,
  setSysmonProbe,
  // Plan 31 test hooks: what the Docker tab asked for, how the daemon is
  // reached, and a way to put the made-up host back.
  dockerCalls,
  setDockerAccess,
  resetDocker,
};

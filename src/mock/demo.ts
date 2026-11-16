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
import { useSnippets } from "@/stores/snippetsStore";
import { useToasts } from "@/stores/toastStore";
import { useBindings } from "@/stores/bindingsStore";
import { useSync } from "@/stores/syncStore";
import { useUpdater } from "@/stores/updaterStore";
import { emit } from "./event";
import { seed as seedTransfers, calls as transferCalls } from "./transfers";
import { calls as sysmonCalls, setProbe as setSysmonProbe } from "./sysmon";

(window as any).__demo = {
  useLayout,
  useConnections,
  useTransfers,
  useBridge,
  useTerminals,
  useSettings,
  useDiskScan,
  useServerView,
  useSnippets,
  useToasts,
  useBindings,
  useSync,
  useUpdater,
  // Convenience: focus a server by profile id (connects if needed).
  focusProfile: (profileId: string) =>
    useConnections.getState().connect(profileId),
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
};

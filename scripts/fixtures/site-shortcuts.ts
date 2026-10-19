import { ipc } from "../../src/lib/ipc";
import { useSites } from "../../src/stores/sitesStore";
import { useConnections } from "../../src/stores/connectionsStore";
import { useSettings } from "../../src/stores/settingsStore";
import { useLayout } from "../../src/stores/layoutStore";

// Exercise production stores and components against the mock transport. Only
// database persistence and fault/delay injection are replaced for these tests.
const originalConnect = ipc.connect;
const settings: Record<string, string> = JSON.parse(sessionStorage.getItem("site-test-settings") ?? "{}");
const control = {
  useSites, useConnections, useSettings, useLayout,
  settings,
  failSave: false,
  failConnect: false,
  delayConnect: false,
  connectCalls: [] as string[],
  releaseConnect: () => {},
};
ipc.settingsGetAll = async () => ({ ...settings });
ipc.settingsSet = async (key, value) => {
  if (key === "siteShortcuts" && control.failSave) throw new Error("Test: database unavailable");
  settings[key] = value;
  sessionStorage.setItem("site-test-settings", JSON.stringify(settings));
};
ipc.connect = async profileId => {
  control.connectCalls.push(profileId);
  if (control.failConnect) throw new Error("Test: connection refused");
  if (control.delayConnect) await new Promise<void>(resolve => { control.releaseConnect = resolve; });
  return originalConnect(profileId);
};
Object.assign(window, { siteTest: control });
useSettings.setState({ railExpanded: true, browserLayout: "single" });
await import("../../src/main");

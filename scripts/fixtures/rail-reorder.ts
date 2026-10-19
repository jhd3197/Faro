import { ipc } from "../../src/lib/ipc";
import { useConnections } from "../../src/stores/connectionsStore";
import { useSettings } from "../../src/stores/settingsStore";
import * as data from "../../src/mock/data";

const saved = sessionStorage.getItem("rail-test-profiles");
if (saved) data.setProfiles(JSON.parse(saved));
const save = ipc.saveProfile;
const reorder = ipc.reorderProfiles;
const control = { useConnections, useSettings, reorderCalls: 0, failReorder: false, nativeDragStarts: 0 };
ipc.saveProfile = async profile => {
  await save(profile);
  sessionStorage.setItem("rail-test-profiles", JSON.stringify(data.profiles));
};
ipc.reorderProfiles = async ids => {
  control.reorderCalls++;
  if (control.failReorder) throw new Error("Test: cannot save order");
  await reorder(ids);
  sessionStorage.setItem("rail-test-profiles", JSON.stringify(data.profiles));
};
// Windows' native webview drop handler prevents HTML5 DnD. Pointer dragging
// must work even when that browser mechanism is unavailable.
document.addEventListener("dragstart", e => { control.nativeDragStarts++; e.preventDefault(); }, true);
Object.assign(window, { railTest: control });
useSettings.setState({ railExpanded: true, browserLayout: "single" });
await import("../../src/main");

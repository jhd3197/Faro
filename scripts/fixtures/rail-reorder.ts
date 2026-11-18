import { ipc } from "../../src/lib/ipc";
import { useConnections } from "../../src/stores/connectionsStore";
import { useSettings } from "../../src/stores/settingsStore";
import * as data from "../../src/mock/data";

const saved = sessionStorage.getItem("rail-test-profiles");
if (saved) data.setProfiles(JSON.parse(saved));
const save = ipc.saveProfile;
const organize = ipc.organizeProfiles;
// Rail order and folders are saved through organizeProfiles (one recoverable
// write per drag); `organizeLog` records what each call asked the backend for.
const control = {
  useConnections,
  useSettings,
  organizeCalls: 0,
  organizeLog: [] as { id: string; group?: string; sortOrder?: number }[][],
  failOrganize: false,
  nativeDragStarts: 0,
};
const persist = () => sessionStorage.setItem("rail-test-profiles", JSON.stringify(data.profiles));
ipc.saveProfile = async profile => {
  await save(profile);
  persist();
};
ipc.organizeProfiles = async (changes, expected) => {
  control.organizeCalls++;
  control.organizeLog.push(changes.map(c => ({ ...c })));
  if (control.failOrganize) throw new Error("Test: cannot save order");
  const before = await organize(changes, expected);
  persist();
  return before;
};
// Windows' native webview drop handler prevents HTML5 DnD. Pointer dragging
// must work even when that browser mechanism is unavailable.
document.addEventListener("dragstart", e => { control.nativeDragStarts++; e.preventDefault(); }, true);
Object.assign(window, { railTest: control });
useSettings.setState({ railExpanded: true, browserLayout: "single" });
await import("../../src/main");

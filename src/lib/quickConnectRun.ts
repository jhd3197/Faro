// Runs a quick connect (see quickConnect.ts for the parsing and the rules).

import { useConnections } from "@/stores/connectionsStore";
import { useLayout } from "@/stores/layoutStore";
import { toast } from "@/stores/toastStore";
import { kindOf } from "./errors";
import { findSavedTarget, quickProfile, type QuickTarget } from "./quickConnect";

export async function runQuickConnect(target: QuickTarget): Promise<void> {
  const conns = useConnections.getState();
  const saved = findSavedTarget(conns.profiles, target);
  if (saved) {
    await conns.connect(saved.id).catch(() => {});
    return;
  }
  const profile = quickProfile(target, crypto.randomUUID());
  await conns.saveProfile(profile);
  try {
    await useConnections.getState().connect(profile.id);
    toast.success("Connection saved", `${profile.name} is now in your connection list.`);
  } catch (e) {
    // A host that didn't connect is not kept.
    await useConnections.getState().deleteProfile(profile.id).catch(() => {});
    if (kindOf(e) === "auth") {
      const { id: _id, ...rest } = profile;
      useLayout.getState().openNewConnection({ ...rest, auth: { kind: "password", password: "" } });
      toast.info("Sign-in needed", "No SSH key was accepted. Enter a password or choose a key.");
    }
  }
}

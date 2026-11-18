import { create } from "zustand";
import type { FocusedFileItem } from "@faro/file-ui";

// The item that has keyboard focus, shared so commands can act on it instead
// of guessing (e.g. "Open terminal here" opens in the focused folder). File
// panes announce their focused row with a "faro:focused-item" window event;
// the server rail sets the focused server directly.

export type FocusedItem =
  | ({ kind: "file" } & FocusedFileItem)
  | { kind: "server"; profileId: string };

interface FocusState {
  item: FocusedItem | null;
  setItem: (item: FocusedItem | null) => void;
}

export const useFocusedItem = create<FocusState>((set) => ({
  item: null,
  setItem: (item) => set({ item }),
}));

if (typeof window !== "undefined") {
  window.addEventListener("faro:focused-item", (ev) => {
    const d = (ev as CustomEvent).detail as (FocusedFileItem & { cleared?: undefined }) | { paneId: string; cleared: true };
    const cur = useFocusedItem.getState().item;
    if (d.cleared) {
      if (cur?.kind === "file" && cur.paneId === d.paneId) useFocusedItem.getState().setItem(null);
      return;
    }
    useFocusedItem.getState().setItem({ kind: "file", ...d });
  });
}

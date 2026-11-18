import { type ReactNode } from "react";
import { FileUiProvider } from "@faro/file-ui";
import { useSettings } from "@/stores/settingsStore";
import { useFileBrowserKeyBindings } from "@/lib/fileBrowserKeys";
import { tauriFileSystem } from "@/lib/fileUiAdapter";
import { usePanelSizes } from "@/stores/panelSizesStore";

// Bridges Faro's zustand settings store + Tauri adapter into the @faro/file-ui
// context. Mounted once around the browser area so every <FilePane> (single or
// dual layout) gets the same wiring. Reads the whole settings store so view
// state (sort / view-mode / density) stays live as the user changes it.
export function FileUiBridge({ children }: { children: ReactNode }) {
  const s = useSettings();
  const keyBindings = useFileBrowserKeyBindings();
  const columnWidths = usePanelSizes((p) => p.columns);
  const setColumnWidths = usePanelSizes((p) => p.setColumns);
  return (
    <FileUiProvider
      fs={tauriFileSystem}
      settings={{
        showHiddenFiles: s.showHiddenFiles,
        sortField: s.sortField,
        sortDirection: s.sortDirection,
        paneViewMode: s.paneViewMode,
        paneDensity: s.paneDensity,
        editorLabel: s.defaultEditor || undefined,
        remoteImagePreviews: s.remoteImagePreviews === "on",
        keyBindings,
        columnWidths,
        setColumnWidths,
        setSortField: s.setSortField,
        setSortDirection: s.setSortDirection,
        setPaneViewMode: s.setPaneViewMode,
        setPaneDensity: s.setPaneDensity,
        setRemoteImagePreviews: (on) =>
          s.setRemoteImagePreviews(on ? "on" : "off"),
      }}
    >
      {children}
    </FileUiProvider>
  );
}

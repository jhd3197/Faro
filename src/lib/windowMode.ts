import { getCurrentWindow } from "@tauri-apps/api/window";
import { useLayout } from "@/stores/layoutStore";

// Full screen (F11) and Zen mode (the file panes only). Zen also goes full
// screen, since it hides the title bar that drags and closes the window, and
// leaving Zen restores whatever full-screen state the user had before.

let fullscreenBeforeZen: boolean | null = null;

async function isFullscreen(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFullscreen();
  } catch {
    return false;
  }
}

async function setFullscreen(on: boolean): Promise<void> {
  try {
    await getCurrentWindow().setFullscreen(on);
  } catch {
    // A webview without the permission (or the demo build) just keeps its size.
  }
}

export async function toggleFullscreen(): Promise<void> {
  await setFullscreen(!(await isFullscreen()));
}

export async function setZen(on: boolean): Promise<void> {
  const layout = useLayout.getState();
  if (layout.zen === on) return;
  if (on) {
    fullscreenBeforeZen = await isFullscreen();
    layout.setZen(true);
    await setFullscreen(true);
  } else {
    layout.setZen(false);
    if (fullscreenBeforeZen === false) await setFullscreen(false);
    fullscreenBeforeZen = null;
  }
}

export function toggleZen(): Promise<void> {
  return setZen(!useLayout.getState().zen);
}

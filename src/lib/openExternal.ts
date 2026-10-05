import { ipc } from "@/lib/ipc";
import { toastError } from "@/lib/errors";

/** Open a web link in the system browser. Under Tauri 2 `window.open` from the
 *  webview goes nowhere, so every external link goes through the backend. */
export function openExternal(url: string) {
  ipc.openExternalUrl(url).catch((e) => toastError(e, "Open link"));
}

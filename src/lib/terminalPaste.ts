// Image paste (Plan 36 Phase 3): the pure parts — how a saved image's path is
// typed into a shell, and turning a blob into what the IPC call takes.

/** Largest image a paste uploads; mirrors `MAX_PASTE_BYTES` in the backend. */
export const MAX_PASTE_BYTES = 20 * 1024 * 1024;

/** `path` as it should be typed at a prompt. POSIX shells get single quotes
 *  when the path has anything a shell would interpret; a Windows path gets
 *  double quotes when it has a space (cmd and PowerShell both accept that). */
export function quotePastePath(path: string): string {
  const windows = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
  if (windows) return /[\s&()^;,=]/.test(path) ? `"${path}"` : path;
  if (/^[\w@%+=:,./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The first image on a clipboard that holds no text, else null. Text wins:
 *  a copied spreadsheet cell carries both, and the user means the text. */
export function clipboardImage(data: DataTransfer | null): File | null {
  if (!data) return null;
  if (data.getData("text/plain")) return null;
  for (const item of Array.from(data.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/** File extension for a clipboard image's MIME type. */
export function imageExt(mime: string): string {
  const sub = mime.split("/")[1]?.split(/[+;]/)[0]?.toLowerCase() ?? "";
  return sub === "jpeg" ? "jpg" : sub || "png";
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // In chunks: one call with every byte as an argument overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

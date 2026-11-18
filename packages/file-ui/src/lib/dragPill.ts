// The label that follows the pointer while files are dragged ("2 folders,
// 3 files", then "Move to src" over a folder). The browser's own drag ghost is
// replaced by a transparent image so only this pill shows. It's plain DOM, not
// React: one pill for the whole window, whichever pane the drag crosses.

const PILL_CLASS =
  "pointer-events-none fixed left-0 top-0 z-[1000] flex max-w-[18rem] flex-col rounded-md border border-accent/50 bg-bg-panel px-2 py-1 text-xs text-text shadow-elev-2";
const HINT_CLASS = "truncate text-[11px] text-accent";

let pill: HTMLDivElement | null = null;
let hintEl: HTMLSpanElement | null = null;
let blank: HTMLImageElement | null = null;

function blankImage(): HTMLImageElement {
  if (!blank) {
    blank = new Image(1, 1);
    blank.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  }
  return blank;
}

// Decode it up front: an image that isn't loaded yet at dragstart is ignored.
if (typeof Image !== "undefined") blankImage();

const place =(x: number, y: number) => {
  if (pill) pill.style.transform = `translate(${x + 14}px, ${y + 12}px)`;
};

const onMove = (e: DragEvent) => {
  // Chromium reports 0,0 for the last event as the pointer leaves the window.
  if (e.clientX === 0 && e.clientY === 0) return;
  place(e.clientX, e.clientY);
};

/** Show the pill for a drag that just started. */
export function startDragPill(e: DragEvent, label: string): void {
  endDragPill();
  try {
    e.dataTransfer?.setDragImage(blankImage(), 0, 0);
  } catch {
    /* an old engine keeps its own ghost; the pill still shows */
  }
  pill = document.createElement("div");
  pill.className = PILL_CLASS;
  pill.setAttribute("data-drag-pill", "");
  const text = document.createElement("span");
  text.className = "truncate font-medium";
  text.textContent = label;
  hintEl = document.createElement("span");
  hintEl.className = HINT_CLASS;
  hintEl.hidden = true;
  pill.append(text, hintEl);
  document.body.appendChild(pill);
  place(e.clientX, e.clientY);
  document.addEventListener("dragover", onMove, true);
  document.addEventListener("drop", endDragPill, true);
  document.addEventListener("dragend", endDragPill, true);
}

/** The second line: what a drop here would do, or nothing. */
export function setDragPillHint(hint: string | null): void {
  if (!hintEl) return;
  hintEl.textContent = hint ?? "";
  hintEl.hidden = !hint;
}

export function endDragPill(): void {
  document.removeEventListener("dragover", onMove, true);
  document.removeEventListener("drop", endDragPill, true);
  document.removeEventListener("dragend", endDragPill, true);
  pill?.remove();
  pill = null;
  hintEl = null;
}

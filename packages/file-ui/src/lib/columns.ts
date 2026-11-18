// Resizable details-view columns. Widths are stored as percentages of the
// list width (so they survive a pane resize) and rendered as `fr` weights with
// a pixel floor. Until the user drags a handle the pane keeps its built-in
// template, and a double-click on any handle goes back to it.

export type ColumnId = "name" | "modified" | "size" | "perms";
export type ColumnWidths = Partial<Record<ColumnId, number>>;

/** Share of the list each column gets once widths are customised. */
export const DEFAULT_COLUMN_WIDTHS: Record<ColumnId, number> = {
  name: 60,
  modified: 18,
  size: 11,
  perms: 11,
};

/** Narrowest a column can be dragged. */
export const COLUMN_MIN_PX: Record<ColumnId, number> = {
  name: 96,
  modified: 64,
  size: 48,
  perms: 48,
};

export const COLUMN_LABELS: Record<ColumnId, string> = {
  name: "Name",
  modified: "Modified",
  size: "Size",
  perms: "Perms",
};

const weight = (w: ColumnWidths | null | undefined, id: ColumnId) =>
  w?.[id] ?? DEFAULT_COLUMN_WIDTHS[id];

/** grid-template-columns for the visible columns at the stored widths. */
export function columnTemplate(visible: ColumnId[], widths: ColumnWidths): string {
  return visible
    .map((id) => `minmax(${COLUMN_MIN_PX[id]}px, ${weight(widths, id).toFixed(2)}fr)`)
    .join(" ");
}

/**
 * Move the boundary after column `index` by `delta` px. Only that column and
 * its right-hand neighbour change; the pair's combined width (and every other
 * column) stays put. `px` are the visible columns' current rendered widths.
 * Hidden columns keep their stored share.
 */
export function resizeColumns(
  visible: ColumnId[],
  px: number[],
  index: number,
  delta: number,
  base: ColumnWidths | null | undefined
): ColumnWidths {
  const a = visible[index];
  const b = visible[index + 1];
  const next = px.slice();
  const pair = px[index] + px[index + 1];
  const left = Math.min(pair - COLUMN_MIN_PX[b], Math.max(COLUMN_MIN_PX[a], px[index] + delta));
  next[index] = left;
  next[index + 1] = pair - left;
  const total = next.reduce((s, v) => s + v, 0) || 1;
  const share = visible.reduce((s, id) => s + weight(base, id), 0);
  const out: ColumnWidths = {};
  for (const id of Object.keys(DEFAULT_COLUMN_WIDTHS) as ColumnId[]) out[id] = weight(base, id);
  visible.forEach((id, i) => {
    out[id] = Math.round((next[i] / total) * share * 100) / 100;
  });
  return out;
}

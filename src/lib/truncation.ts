/** Whether any `.truncate` text inside `root` (or root itself) is cut off with
 *  an ellipsis right now. Measure on hover: a label can be clipped at one rail
 *  width and fit at another. */
export function isClipped(root: Element | null | undefined): boolean {
  if (!root) return false;
  const els = [
    ...(root.classList.contains("truncate") ? [root] : []),
    ...root.querySelectorAll(".truncate"),
  ];
  return els.some((el) => el.scrollWidth > el.clientWidth + 1);
}

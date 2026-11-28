// One place decides how a time of day is written (Plan 37 Phase 2), so file
// dates, logs, the agent panel and Settings all agree and all follow the
// "Time format" setting: Automatic (the UI language's convention), 12-hour or
// 24-hour.
//
// Dates stay `YYYY-MM-DD`: unambiguous in every locale and sortable as text.

import { setHour12Clock } from "@faro/file-ui";

export type TimeFormat = "auto" | "12h" | "24h";

/** Does this locale write times with AM/PM? `undefined` = the OS locale. */
export function localeUses12h(locale?: string): boolean {
  try {
    return (
      new Intl.DateTimeFormat(locale || undefined, { hour: "numeric" }).resolvedOptions().hour12 ===
      true
    );
  } catch {
    return false;
  }
}

/** Whether the clock is 12-hour for this setting and UI language. */
export function resolveHour12(format: TimeFormat, uiLanguage: string): boolean {
  if (format === "12h") return true;
  if (format === "24h") return false;
  return localeUses12h(uiLanguage === "system" ? undefined : uiLanguage);
}

let hour12 = false;

/** Apply the clock style everywhere, including the file list package. */
export function setClock(use12h: boolean): void {
  hour12 = use12h;
  setHour12Clock(use12h);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A time of day: `14:32` or `2:32 PM` (with seconds when asked). */
export function fmtClock(date: Date, opts?: { seconds?: boolean; hour12?: boolean }): string {
  const use12h = opts?.hour12 ?? hour12;
  const h = date.getHours();
  const tail = `:${pad(date.getMinutes())}${opts?.seconds ? `:${pad(date.getSeconds())}` : ""}`;
  if (!use12h) return `${pad(h)}${tail}`;
  return `${h % 12 === 0 ? 12 : h % 12}${tail} ${h < 12 ? "AM" : "PM"}`;
}

/** A date and time: `2024-05-21 14:32`. Empty for an unknown time. */
export function fmtDateTime(
  ms: number | undefined | null,
  opts?: { seconds?: boolean; hour12?: boolean }
): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtClock(d, opts)}`;
}

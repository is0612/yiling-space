/**
 * Format an instant using the character's configured IANA time zone.
 * Calendar day keys are computed in that zone too; using the browser zone here
 * would make the displayed clock disagree with the selected calendar day.
 */
export function formatDayClock(value: string | null | undefined, timeZone: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    // Invalid legacy settings should not break the whole calendar page.
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  }
}

export type MarketSession = { open: boolean; label: string; timezone: "Asia/Kolkata" };

export function kolkataParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number; weekday: string; dateKey: string } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday,
    dateKey: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`,
  };
}

/** NSE cash session approximation: weekdays 09:15–15:30 Asia/Kolkata, plus an optional holiday list. */
export function nseCashSession(now: Date, holidays: string[] = []): MarketSession {
  const parts = kolkataParts(now);
  if (parts.weekday === "Sat" || parts.weekday === "Sun" || holidays.includes(parts.dateKey)) {
    return { open: false, label: "Market closed", timezone: "Asia/Kolkata" };
  }
  const minutes = parts.hour * 60 + parts.minute;
  const open = minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 30;
  return { open, label: open ? "Market open" : "Market closed", timezone: "Asia/Kolkata" };
}

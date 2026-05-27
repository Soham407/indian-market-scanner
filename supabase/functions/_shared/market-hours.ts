const IST_TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET_MINUTES = 330;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// NSE full-day trading holidays (not just settlement holidays).
// Source: https://www.nseindia.com/resources/exchange-communication-holidays
// IMPORTANT: NSE publishes a fresh list every December for the next calendar
// year. Re-verify and extend this set in early January.
// Format: YYYY-MM-DD in IST.
const NSE_HOLIDAYS = new Set<string>([
  // ---- 2026 (verify against the official NSE calendar) ----
  "2026-01-26", // Republic Day
  "2026-02-19", // Mahashivratri
  "2026-03-03", // Holi
  "2026-03-20", // Eid Ul Fitr (lunar — verify)
  "2026-04-03", // Good Friday
  "2026-04-14", // Dr. Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  // "2026-05-27" removed — Bakri Id 2026 is ~Jun 6–7 per Islamic calendar; NSE was open
  "2026-08-17", // Janmashtami
  "2026-10-02", // Gandhi Jayanti
  "2026-10-28", // Diwali — Laxmi Pujan (verify exact date via NSE calendar each year)
  "2026-11-04", // Guru Nanak Jayanti
  "2026-12-25", // Christmas
]);

function istDateString(now = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

export function isNseHoliday(now = new Date()): boolean {
  return NSE_HOLIDAYS.has(istDateString(now));
}

export function getMarketSessionStatus(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  const weekday = WEEKDAYS[ist.getUTCDay()];
  const hour = ist.getUTCHours();
  const minute = ist.getUTCMinutes();
  const minutesSinceMidnight = hour * 60 + minute;
  const isWeekday = !["Sat", "Sun"].includes(weekday);
  const isRegularSession =
    minutesSinceMidnight >= 9 * 60 + 15 &&
    minutesSinceMidnight <= 15 * 60 + 30;
  const holiday = isNseHoliday(now);

  return {
    isOpen: isWeekday && isRegularSession && !holiday,
    weekday,
    holiday,
    istDate: istDateString(now),
    istTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

export function marketClosedResponse(now = new Date()) {
  const session = getMarketSessionStatus(now);

  return Response.json({
    status: session.holiday
      ? "NSE holiday, standing by."
      : "Market closed, standing by.",
    market: "NSE",
    timezone: IST_TIME_ZONE,
    weekday: session.weekday,
    holiday: session.holiday,
    ist_date: session.istDate,
    ist_time: session.istTime,
  });
}

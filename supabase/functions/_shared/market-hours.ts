const IST_TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET_MINUTES = 330;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// NSE full-day trading holidays (equity cash segment only).
// Source: NSE circular CMTR71775 / Zerodha 2026 holiday list
// https://zerodha.com/z-connect/queries/stock-and-fo-queries/trading-holiday-list-2026
// IMPORTANT: NSE publishes a fresh list every December for the next calendar
// year. Re-verify and extend this set in early January.
// Format: YYYY-MM-DD in IST. Weekend dates are never listed (already non-trading).
const NSE_HOLIDAYS = new Set<string>([
  // ---- 2026 official NSE trading holidays ----
  "2026-01-15", // Municipal Corporation of Greater Mumbai Elections
  "2026-01-26", // Republic Day
  "2026-03-03", // Holi
  "2026-03-26", // Shri Ram Navami
  "2026-03-31", // Shri Mahavir Jayanti
  "2026-04-03", // Good Friday
  "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  "2026-05-28", // Bakri Eid (Eid ul-Adha)
  "2026-06-26", // Moharram
  "2026-09-14", // Ganesh Chaturthi
  "2026-10-02", // Gandhi Jayanti
  "2026-10-20", // Dussehra (Vijayadashami)
  "2026-11-10", // Diwali — Balipratipada (Laxmi Pujan falls on Sunday Nov 8)
  "2026-11-24", // Prakash Gurpurb Sri Guru Nanak Dev Ji
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

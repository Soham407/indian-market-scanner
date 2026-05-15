const IST_TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET_MINUTES = 330;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

  return {
    isOpen: isWeekday && isRegularSession,
    weekday,
    istTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

export function marketClosedResponse(now = new Date()) {
  const session = getMarketSessionStatus(now);

  return Response.json({
    status: "Market closed, standing by.",
    market: "NSE",
    timezone: IST_TIME_ZONE,
    weekday: session.weekday,
    ist_time: session.istTime,
  });
}

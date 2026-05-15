const IST_TIME_ZONE = "Asia/Kolkata";

export function getMarketSessionStatus(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: IST_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const weekday = part("weekday");
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
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

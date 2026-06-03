/** Returns true if `now` falls inside the NSE equity session (Mon–Fri, 09:15–15:30 IST). */
export function isNseMarketOpen(now = new Date()): boolean {
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const day = ist.getUTCDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return false;
  const totalMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return totalMin >= 9 * 60 + 15 && totalMin < 15 * 60 + 30;
}

/** Formats a Date as "HH:MM AM/PM IST" */
export function fmtIstTime(date: Date): string {
  return new Date(date.getTime() + 5.5 * 60 * 60 * 1000).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
}

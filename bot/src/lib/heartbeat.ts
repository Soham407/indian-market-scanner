export type HeartbeatStatus = {
  isAlive: boolean;
  label: "ALIVE" | "STALE" | "STANDBY";
  secondsAgo: number | null;
  message: string;
};

const STALE_AFTER_SECONDS = 90;
const NSE_HOLIDAYS = new Set([
  "2026-01-15", "2026-01-26", "2026-03-03", "2026-03-26",
  "2026-03-31", "2026-04-03", "2026-04-14", "2026-05-01",
  "2026-05-28", "2026-06-26", "2026-09-14", "2026-10-02",
  "2026-10-20", "2026-11-10", "2026-11-24", "2026-12-25",
]);

export function isNseDashboardSessionOpen(now = new Date()): boolean {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const weekday = ist.getUTCDay();
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const istDate = ist.toISOString().slice(0, 10);
  return weekday >= 1 &&
    weekday <= 5 &&
    minutes >= 9 * 60 + 15 &&
    minutes <= 15 * 60 + 30 &&
    !NSE_HOLIDAYS.has(istDate);
}

export function getHeartbeatStatus(lastHeartbeatAt: string | null, now = new Date()): HeartbeatStatus {
  if (!isNseDashboardSessionOpen(now)) {
    return {
      isAlive: true,
      label: "STANDBY",
      secondsAgo: null,
      message: "market closed",
    };
  }

  if (!lastHeartbeatAt) {
    return {
      isAlive: false,
      label: "STALE",
      secondsAgo: null,
      message: "never",
    };
  }

  const heartbeatTime = new Date(lastHeartbeatAt).getTime();
  const secondsAgo = Math.max(0, Math.floor((now.getTime() - heartbeatTime) / 1000));
  const isAlive = Number.isFinite(heartbeatTime) && secondsAgo <= STALE_AFTER_SECONDS;

  return {
    isAlive,
    label: isAlive ? "ALIVE" : "STALE",
    secondsAgo,
    message: `${secondsAgo}s ago`,
  };
}

export type PremiumDecayCollectorStatus = {
  label: "ACTIVE" | "STALE" | "ERROR" | "STANDBY";
  message: string;
};

export function getPremiumDecayCollectorStatus(
  lastSampleAt: string | null,
  lastErrorAt: string | null,
  lastErrorMessage: string | null,
  now = new Date(),
): PremiumDecayCollectorStatus {
  if (!isNseDashboardSessionOpen(now)) return { label: "STANDBY", message: "market closed" };
  if (lastErrorAt) return { label: "ERROR", message: lastErrorMessage ?? "collector failed" };
  if (!lastSampleAt) return { label: "STALE", message: "no sample received" };

  const secondsAgo = Math.max(0, Math.floor((now.getTime() - new Date(lastSampleAt).getTime()) / 1000));
  return secondsAgo <= STALE_AFTER_SECONDS
    ? { label: "ACTIVE", message: `${secondsAgo}s ago` }
    : { label: "STALE", message: `${secondsAgo}s ago` };
}

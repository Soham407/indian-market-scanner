export type CandleSnapshot = {
  close: number;
  volume: number;
  candle_open_at: string;
};

function formatAge(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m ago`;
}

export function getCandleAgeLabel(candleOpenAt: string, now = new Date()): string {
  const candleTime = new Date(candleOpenAt).getTime();
  if (!Number.isFinite(candleTime)) {
    return "unknown";
  }

  const secondsAgo = Math.max(0, Math.floor((now.getTime() - candleTime) / 1000));
  return formatAge(secondsAgo);
}

export function formatVolume(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
  }).format(value);
}

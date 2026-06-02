export type PremiumDecayRow = {
  id: string;
  series_key: string;
  instrument_symbol: string;
  expiry_date: string;
  strike: number | string;
  sampled_at: string;
  underlying_ltp: number | string;
  ce_ltp?: number | string;
  pe_ltp?: number | string;
  ce_decay: number | string;
  pe_decay: number | string;
};

export type PremiumDecayPoint = {
  id: string;
  seriesKey: string;
  instrumentSymbol: string;
  expiryDate: string;
  strike: number;
  sampledAt: Date;
  underlyingLtp: number;
  ceDecay: number;
  peDecay: number;
  chartPeDecay: number;
};

export type PremiumDecayMinutePoint = PremiumDecayPoint & {
  minuteKey: string;
  isCarriedForward: boolean;
};

function toFiniteNumber(value: number | string, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${fieldName}: ${String(value)}`);
  }
  return parsed;
}

export function normalizePremiumDecayRows(rows: PremiumDecayRow[]): PremiumDecayPoint[] {
  const byId = new Map<string, PremiumDecayPoint>();

  for (const row of rows) {
    const point: PremiumDecayPoint = {
      id: row.id,
      seriesKey: row.series_key,
      instrumentSymbol: row.instrument_symbol,
      expiryDate: row.expiry_date,
      strike: toFiniteNumber(row.strike, "strike"),
      sampledAt: new Date(row.sampled_at),
      underlyingLtp: toFiniteNumber(row.underlying_ltp, "underlying_ltp"),
      ceDecay: toFiniteNumber(row.ce_decay, "ce_decay"),
      peDecay: toFiniteNumber(row.pe_decay, "pe_decay"),
      chartPeDecay: toFiniteNumber(row.pe_decay, "pe_decay"),
    };

    if (Number.isNaN(point.sampledAt.getTime())) {
      throw new Error(`Invalid sampled_at: ${row.sampled_at}`);
    }

    byId.set(point.id, point);
  }

  return [...byId.values()].sort((a, b) => a.sampledAt.getTime() - b.sampledAt.getTime());
}

export function formatPremiumDecayTime(sampledAt: Date): string {
  return sampledAt.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

export function toIstMinuteKey(sampledAt: Date): string {
  const ist = new Date(sampledAt.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 16);
}

export function toIstDateKey(sampledAt: Date): string {
  return toIstMinuteKey(sampledAt).slice(0, 10);
}

export function getIstSessionBounds(sessionDate: string) {
  return {
    start: `${sessionDate}T03:45:00.000Z`,
    end: `${sessionDate}T10:01:00.000Z`,
  };
}

export function isPointInIstSession(point: Pick<PremiumDecayPoint, "sampledAt">, sessionDate: string): boolean {
  const minuteKey = toIstMinuteKey(point.sampledAt);
  if (!minuteKey.startsWith(sessionDate)) return false;

  const [hour, minute] = minuteKey.slice(11).split(":").map(Number);
  const minutesSinceMidnight = hour * 60 + minute;
  return minutesSinceMidnight >= 9 * 60 + 15 && minutesSinceMidnight <= 15 * 60 + 30;
}

export function filterCompletedSessionDates(sessionDates: string[], now = new Date()): string[] {
  const today = toIstDateKey(now);
  return [...new Set(sessionDates)]
    .filter((sessionDate) => sessionDate < today)
    .sort()
    .reverse();
}

export function keepLatestIstSessionPoints(points: PremiumDecayPoint[]): PremiumDecayPoint[] {
  const sessionPoints = points.filter((point) => isPointInIstSession(point, toIstDateKey(point.sampledAt)));
  const latest = sessionPoints.at(-1);
  if (!latest) return [];

  const latestIstDate = toIstDateKey(latest.sampledAt);
  return sessionPoints.filter((point) => isPointInIstSession(point, latestIstDate));
}

export function buildOneMinutePremiumDecaySeries(points: PremiumDecayPoint[]): PremiumDecayMinutePoint[] {
  const sessionPoints = keepLatestIstSessionPoints(points);
  if (sessionPoints.length === 0) return [];

  const byMinute = new Map(sessionPoints.map((point) => [toIstMinuteKey(point.sampledAt), point]));
  const firstMinute = Math.floor(sessionPoints[0].sampledAt.getTime() / 60_000) * 60_000;
  const lastMinute = Math.floor(sessionPoints.at(-1)!.sampledAt.getTime() / 60_000) * 60_000;
  const slots: PremiumDecayMinutePoint[] = [];
  let lastKnown = sessionPoints[0];

  for (let cursor = firstMinute; cursor <= lastMinute; cursor += 60_000) {
    const sampledAt = new Date(cursor);
    const minuteKey = toIstMinuteKey(sampledAt);
    const point = byMinute.get(minuteKey);
    if (point) lastKnown = point;

    slots.push({
      ...lastKnown,
      sampledAt,
      minuteKey,
      isCarriedForward: !point,
    });
  }

  return slots;
}

export function buildLinearPremiumDecayPath(
  points: Pick<PremiumDecayPoint, "ceDecay" | "chartPeDecay">[],
  key: "ceDecay" | "chartPeDecay",
  scaleX: (index: number) => number,
  scaleY: (value: number) => number,
): string {
  return points.map((point, index) => {
    const command = index === 0 ? "M" : "L";
    return `${command} ${scaleX(index).toFixed(2)},${scaleY(point[key]).toFixed(2)}`;
  }).join(" ");
}

export function buildPremiumDecayAreaPath(
  points: Pick<PremiumDecayPoint, "ceDecay" | "chartPeDecay">[],
  key: "ceDecay" | "chartPeDecay",
  scaleX: (index: number) => number,
  scaleY: (value: number) => number,
): string {
  if (points.length === 0) return "";

  const firstX = scaleX(0);
  const lastX = scaleX(points.length - 1);
  const baselineY = scaleY(0);
  return `${buildLinearPremiumDecayPath(points, key, scaleX, scaleY)} L ${lastX.toFixed(2)},${baselineY.toFixed(2)} L ${firstX.toFixed(2)},${baselineY.toFixed(2)} Z`;
}

export function buildReadableTimeTickIndices(
  totalSlots: number,
  chartWidth: number,
  minimumSpacing = 72,
): number[] {
  if (totalSlots <= 0) return [];
  if (totalSlots === 1) return [0];

  const slotWidth = chartWidth / (totalSlots - 1);
  const rawStep = Math.ceil(minimumSpacing / slotWidth);
  const step = Math.max(5, Math.ceil(rawStep / 5) * 5);
  const lastIndex = totalSlots - 1;
  const indices: number[] = [];

  for (let index = 0; index <= lastIndex; index += step) {
    indices.push(index);
  }

  if (indices.at(-1) !== lastIndex) {
    if (lastIndex - indices.at(-1)! < step) indices.pop();
    indices.push(lastIndex);
  }

  return indices;
}

export function buildBandAveragedSeries(rows: PremiumDecayRow[]): PremiumDecayMinutePoint[] {
  if (rows.length === 0) return [];

  const normalized = keepLatestIstSessionPoints(normalizePremiumDecayRows(rows));
  if (normalized.length === 0) return [];

  const byMinute = new Map<string, PremiumDecayPoint[]>();

  for (const point of normalized) {
    const key = toIstMinuteKey(point.sampledAt);
    const group = byMinute.get(key) ?? [];
    group.push(point);
    byMinute.set(key, group);
  }

  const firstMinute = Math.floor(normalized[0].sampledAt.getTime() / 60_000) * 60_000;
  const lastMinute = Math.floor(normalized.at(-1)!.sampledAt.getTime() / 60_000) * 60_000;
  const slots: PremiumDecayMinutePoint[] = [];
  let lastKnown: PremiumDecayPoint | null = null;

  for (let cursor = firstMinute; cursor <= lastMinute; cursor += 60_000) {
    const sampledAt = new Date(cursor);
    const minuteKey = toIstMinuteKey(sampledAt);
    const group = byMinute.get(minuteKey);

    if (group && group.length > 0) {
      const avgCe = group.reduce((sum, p) => sum + p.ceDecay, 0) / group.length;
      const avgPe = group.reduce((sum, p) => sum + p.peDecay, 0) / group.length;
      const rep = group[0];
      lastKnown = {
        ...rep,
        sampledAt,
        ceDecay: avgCe,
        peDecay: avgPe,
        chartPeDecay: avgPe,
      };
    }

    if (!lastKnown) continue;

    slots.push({
      ...lastKnown,
      sampledAt,
      minuteKey,
      isCarriedForward: !group,
    });
  }

  return slots;
}

export function buildDemoPremiumDecayRows(seriesKey: string): PremiumDecayRow[] {
  const base = new Date("2026-06-01T09:15:00+05:30").getTime();
  const offsets = Array.from({ length: 18 }, (_, index) => index);

  return offsets.map((minuteIndex) => {
    const sampledAt = new Date(base + minuteIndex * 12 * 60 * 1000).toISOString();
    const wave = Math.sin(minuteIndex / 2.2);
    const drift = minuteIndex * 2.8;
    const ceDecay = Math.max(8, 55 + wave * 18 + drift * 0.8);
    const peDecay = -Math.max(6, 42 + Math.cos(minuteIndex / 2.8) * 14 + drift * 0.55);

    return {
      id: `demo-${minuteIndex}`,
      series_key: seriesKey,
      instrument_symbol: "NIFTY",
      expiry_date: "2026-06-02",
      strike: 25000,
      sampled_at: sampledAt,
      underlying_ltp: 24972 + drift * 1.7,
      ce_decay: Number(ceDecay.toFixed(2)),
      pe_decay: Number(peDecay.toFixed(2)),
    };
  });
}

import { describe, expect, it } from "vitest";
import {
  buildBandAveragedSeries,
  buildPremiumDecayAreaPath,
  buildReadableTimeTickIndices,
  buildLinearPremiumDecayPath,
  buildOneMinutePremiumDecaySeries,
  buildDemoPremiumDecayRows,
  filterCompletedSessionDates,
  formatPremiumDecayTime,
  getIstSessionBounds,
  isPointInIstSession,
  keepLatestIstSessionPoints,
  normalizePremiumDecayRows,
  toIstDateKey,
  toIstMinuteKey,
} from "./premium-decay";

describe("premium decay normalization", () => {
  it("sorts rows by time, deduplicates ids, and preserves signed PE movement", () => {
    const rows = normalizePremiumDecayRows([
      {
        id: "2",
        series_key: "NIFTY-2026-06-04-48900",
        instrument_symbol: "NIFTY",
        expiry_date: "2026-06-04",
        strike: "48900",
        sampled_at: "2026-06-01T09:30:00+05:30",
        underlying_ltp: "48895.5",
        ce_decay: "18.2",
        pe_decay: "12.4",
      },
      {
        id: "1",
        series_key: "NIFTY-2026-06-04-48900",
        instrument_symbol: "NIFTY",
        expiry_date: "2026-06-04",
        strike: "48900",
        sampled_at: "2026-06-01T09:15:00+05:30",
        underlying_ltp: "48882.1",
        ce_decay: "13.1",
        pe_decay: "9.9",
      },
      {
        id: "1",
        series_key: "NIFTY-2026-06-04-48900",
        instrument_symbol: "NIFTY",
        expiry_date: "2026-06-04",
        strike: "48900",
        sampled_at: "2026-06-01T09:15:00+05:30",
        underlying_ltp: "48882.1",
        ce_decay: "13.1",
        pe_decay: "9.9",
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("1");
    expect(rows[0].ceDecay).toBe(13.1);
    expect(rows[0].peDecay).toBe(9.9);
    expect(rows[0].chartPeDecay).toBe(9.9);
    expect(rows[1].id).toBe("2");
  });

  it("builds demo rows for an empty dashboard state", () => {
    const rows = buildDemoPremiumDecayRows("NIFTY-ATM-WEEKLY");

    expect(rows).toHaveLength(18);
    expect(rows[0].series_key).toBe("NIFTY-ATM-WEEKLY");
  });
});

describe("premium decay time formatting", () => {
  it("renders IST clock labels", () => {
    expect(formatPremiumDecayTime(new Date("2026-06-01T09:15:00+05:30"))).toMatch(/9:15 AM|9:15 am/i);
  });

  it("normalizes timestamps to one-minute IST keys", () => {
    expect(toIstMinuteKey(new Date("2026-06-01T06:26:59.999Z"))).toBe("2026-06-01T11:56");
  });

  it("rolls the IST date over at midnight rather than UTC midnight", () => {
    expect(toIstDateKey(new Date("2026-06-01T18:29:59.999Z"))).toBe("2026-06-01");
    expect(toIstDateKey(new Date("2026-06-01T18:30:00.000Z"))).toBe("2026-06-02");
  });

  it("builds UTC query bounds for the selected IST market session", () => {
    expect(getIstSessionBounds("2026-06-02")).toEqual({
      start: "2026-06-02T03:45:00.000Z",
      end: "2026-06-02T10:01:00.000Z",
    });
  });

  it("recognizes only points inside the selected IST session", () => {
    expect(isPointInIstSession({ sampledAt: new Date("2026-06-02T03:45:00.000Z") }, "2026-06-02")).toBe(true);
    expect(isPointInIstSession({ sampledAt: new Date("2026-06-02T10:00:59.999Z") }, "2026-06-02")).toBe(true);
    expect(isPointInIstSession({ sampledAt: new Date("2026-06-02T10:01:00.000Z") }, "2026-06-02")).toBe(false);
    expect(isPointInIstSession({ sampledAt: new Date("2026-06-01T10:00:00.000Z") }, "2026-06-02")).toBe(false);
  });

  it("keeps only unique completed historical sessions newest-first", () => {
    expect(filterCompletedSessionDates(
      ["2026-05-29", "2026-06-02", "2026-05-30", "2026-05-29"],
      new Date("2026-06-02T04:00:00.000Z"),
    )).toEqual(["2026-05-30", "2026-05-29"]);
  });
});

describe("one-minute premium decay series", () => {
  it("does not render a carry-forward line across the overnight market close", () => {
    const points = normalizePremiumDecayRows([
      {
        id: "previous-close",
        series_key: "NIFTY-ATM-WEEKLY",
        instrument_symbol: "NIFTY",
        expiry_date: "2026-06-02",
        strike: "23600",
        sampled_at: "2026-06-01T15:30:00+05:30",
        underlying_ltp: "23605.85",
        ce_decay: "-8.2",
        pe_decay: "5.4",
      },
      {
        id: "today-open",
        series_key: "NIFTY-ATM-WEEKLY",
        instrument_symbol: "NIFTY",
        expiry_date: "2026-06-02",
        strike: "23600",
        sampled_at: "2026-06-02T09:15:00+05:30",
        underlying_ltp: "23611.2",
        ce_decay: "0",
        pe_decay: "0",
      },
      {
        id: "today-after-close",
        series_key: "NIFTY-ATM-WEEKLY",
        instrument_symbol: "NIFTY",
        expiry_date: "2026-06-02",
        strike: "23600",
        sampled_at: "2026-06-02T15:31:00+05:30",
        underlying_ltp: "23615.4",
        ce_decay: "-1.2",
        pe_decay: "1.1",
      },
    ]);

    expect(keepLatestIstSessionPoints(points).map((point) => point.id)).toEqual(["today-open"]);
    expect(buildOneMinutePremiumDecaySeries(points).map((point) => point.id)).toEqual(["today-open"]);
  });

  it("creates a separate one-minute slot and carries the last known value across missing samples", () => {
    const points = normalizePremiumDecayRows([
      {
        id: "1",
        series_key: "NIFTY-ATM-WEEKLY",
        instrument_symbol: "NIFTY",
        expiry_date: "2026-06-02",
        strike: "23600",
        sampled_at: "2026-06-01T09:15:05+05:30",
        underlying_ltp: "23605.85",
        ce_decay: "0",
        pe_decay: "0",
      },
      {
        id: "2",
        series_key: "NIFTY-ATM-WEEKLY",
        instrument_symbol: "NIFTY",
        expiry_date: "2026-06-02",
        strike: "23600",
        sampled_at: "2026-06-01T09:18:03+05:30",
        underlying_ltp: "23611.2",
        ce_decay: "-3.9",
        pe_decay: "2.1",
      },
    ]);

    const series = buildOneMinutePremiumDecaySeries(points);

    expect(series).toHaveLength(4);
    expect(series.map((slot) => slot.minuteKey)).toEqual([
      "2026-06-01T09:15",
      "2026-06-01T09:16",
      "2026-06-01T09:17",
      "2026-06-01T09:18",
    ]);
    expect(series.map((slot) => slot.ceDecay)).toEqual([0, 0, 0, -3.9]);
    expect(series.map((slot) => slot.isCarriedForward)).toEqual([false, true, true, false]);
  });

  it("connects adjacent minute values with one straight line segment", () => {
    const path = buildLinearPremiumDecayPath(
      [
        { ceDecay: 0, chartPeDecay: 0 },
        { ceDecay: -3.9, chartPeDecay: 2.1 },
        { ceDecay: -1.2, chartPeDecay: 1.4 },
      ],
      "ceDecay",
      (index) => index * 10,
      (value) => 100 - value,
    );

    expect(path).toBe("M 0.00,100.00 L 10.00,103.90 L 20.00,101.20");
  });

  it("closes an area along the zero baseline without a diagonal wedge", () => {
    const path = buildPremiumDecayAreaPath(
      [
        { ceDecay: 10, chartPeDecay: -5 },
        { ceDecay: 20, chartPeDecay: -10 },
        { ceDecay: 30, chartPeDecay: -15 },
      ],
      "ceDecay",
      (index) => index * 10,
      (value) => 100 - value,
    );

    expect(path).toBe("M 0.00,90.00 L 10.00,80.00 L 20.00,70.00 L 20.00,100.00 L 0.00,100.00 Z");
  });
});

describe("band-average premium decay series", () => {
  it("returns an empty series when every row is outside market hours", () => {
    expect(buildBandAveragedSeries([
      {
        id: "after-close",
        series_key: "NIFTY-BAND-WEEKLY",
        instrument_symbol: "NIFTY",
        expiry_date: "2026-06-02",
        strike: "23600",
        sampled_at: "2026-06-02T15:31:00+05:30",
        underlying_ltp: "23615.4",
        ce_decay: "-1.2",
        pe_decay: "1.1",
      },
    ])).toEqual([]);
  });

  it("does not average or carry rows across the overnight market close", () => {
    const series = buildBandAveragedSeries([
      {
        id: "previous-close",
        series_key: "NIFTY-BAND-WEEKLY",
        instrument_symbol: "NIFTY",
        expiry_date: "2026-06-02",
        strike: "23600",
        sampled_at: "2026-06-01T15:30:00+05:30",
        underlying_ltp: "23605.85",
        ce_decay: "-8.2",
        pe_decay: "5.4",
      },
      {
        id: "today-open",
        series_key: "NIFTY-BAND-WEEKLY",
        instrument_symbol: "NIFTY",
        expiry_date: "2026-06-02",
        strike: "23600",
        sampled_at: "2026-06-02T09:15:00+05:30",
        underlying_ltp: "23611.2",
        ce_decay: "0",
        pe_decay: "0",
      },
      {
        id: "today-after-close",
        series_key: "NIFTY-BAND-WEEKLY",
        instrument_symbol: "NIFTY",
        expiry_date: "2026-06-02",
        strike: "23600",
        sampled_at: "2026-06-02T15:31:00+05:30",
        underlying_ltp: "23615.4",
        ce_decay: "-1.2",
        pe_decay: "1.1",
      },
    ]);

    expect(series.map((point) => point.id)).toEqual(["today-open"]);
  });
});

describe("premium decay axis ticks", () => {
  it("keeps the final time label readable on dense charts", () => {
    const indices = buildReadableTimeTickIndices(121, 904);

    expect(indices.at(-1)).toBe(120);
    expect(indices.every((index, position) => position === 0 || index - indices[position - 1] >= 10)).toBe(true);
  });
});

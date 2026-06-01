import { describe, expect, it } from "vitest";
import {
  buildReadableTimeTickIndices,
  buildLinearPremiumDecayPath,
  buildOneMinutePremiumDecaySeries,
  buildDemoPremiumDecayRows,
  formatPremiumDecayTime,
  normalizePremiumDecayRows,
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
});

describe("one-minute premium decay series", () => {
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
});

describe("premium decay axis ticks", () => {
  it("keeps the final time label readable on dense charts", () => {
    const indices = buildReadableTimeTickIndices(121, 904);

    expect(indices.at(-1)).toBe(120);
    expect(indices.every((index, position) => position === 0 || index - indices[position - 1] >= 10)).toBe(true);
  });
});

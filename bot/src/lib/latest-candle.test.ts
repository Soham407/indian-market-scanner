import { describe, expect, it } from "vitest";
import { formatVolume, getCandleAgeLabel } from "./latest-candle";

describe("getCandleAgeLabel", () => {
  it("formats age in minutes for recent candles", () => {
    const now = new Date("2026-05-26T10:00:00.000Z");
    const label = getCandleAgeLabel("2026-05-26T09:55:00.000Z", now);

    expect(label).toBe("5m ago");
  });

  it("returns unknown for invalid timestamps", () => {
    const label = getCandleAgeLabel("not-a-time", new Date("2026-05-26T10:00:00.000Z"));

    expect(label).toBe("unknown");
  });
});

describe("formatVolume", () => {
  it("formats number with Indian separators", () => {
    expect(formatVolume(1234567)).toBe("12,34,567");
  });
});

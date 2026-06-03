import { describe, expect, it } from "vitest";
import {
  classifyPcr,
  computePcr,
  getHighestOiStrike,
  getNiftyMidValue,
  sumOi,
} from "./oi-analysis";

describe("computePcr", () => {
  it("computes PCR as PE OI divided by CE OI", () => {
    expect(computePcr(10000, 8000)).toBeCloseTo(1.25);
  });

  it("returns null when CE OI is zero to avoid division by zero", () => {
    expect(computePcr(5000, 0)).toBeNull();
  });

  it("returns 0 when PE OI is zero", () => {
    expect(computePcr(0, 8000)).toBe(0);
  });
});

describe("classifyPcr", () => {
  it("classifies PCR above 1.2 as bullish", () => {
    expect(classifyPcr(1.3)).toBe("bullish");
    expect(classifyPcr(2.0)).toBe("bullish");
  });

  it("classifies PCR below 0.8 as bearish", () => {
    expect(classifyPcr(0.7)).toBe("bearish");
    expect(classifyPcr(0.1)).toBe("bearish");
  });

  it("classifies PCR between 0.8 and 1.2 inclusive as neutral", () => {
    expect(classifyPcr(1.0)).toBe("neutral");
    expect(classifyPcr(1.2)).toBe("neutral");
    expect(classifyPcr(0.8)).toBe("neutral");
  });
});

describe("getHighestOiStrike", () => {
  const rows = [
    { strike: 24000, ce_oi: 50000, pe_oi: 20000 },
    { strike: 24500, ce_oi: 80000, pe_oi: 30000 },
    { strike: 25000, ce_oi: 60000, pe_oi: 45000 },
  ];

  it("returns the strike with maximum CE OI", () => {
    expect(getHighestOiStrike(rows, "ce")).toEqual({ strike: 24500, oi: 80000 });
  });

  it("returns the strike with maximum PE OI", () => {
    expect(getHighestOiStrike(rows, "pe")).toEqual({ strike: 25000, oi: 45000 });
  });

  it("returns null when no rows are provided", () => {
    expect(getHighestOiStrike([], "ce")).toBeNull();
    expect(getHighestOiStrike([], "pe")).toBeNull();
  });

  it("handles a single row", () => {
    expect(getHighestOiStrike([{ strike: 24000, ce_oi: 1000, pe_oi: 2000 }], "pe")).toEqual({
      strike: 24000,
      oi: 2000,
    });
  });
});

describe("getNiftyMidValue", () => {
  it("returns the midpoint of high and low", () => {
    expect(getNiftyMidValue(25000, 24000)).toBe(24500);
  });

  it("returns the same value when high equals low", () => {
    expect(getNiftyMidValue(24500, 24500)).toBe(24500);
  });

  it("handles decimal prices", () => {
    expect(getNiftyMidValue(24750.5, 24249.5)).toBe(24500);
  });
});

describe("sumOi", () => {
  it("sums CE OI across all rows", () => {
    const rows = [
      { strike: 24000, ce_oi: 1000, pe_oi: 2000 },
      { strike: 24500, ce_oi: 3000, pe_oi: 4000 },
    ];
    expect(sumOi(rows, "ce")).toBe(4000);
  });

  it("sums PE OI across all rows", () => {
    const rows = [
      { strike: 24000, ce_oi: 1000, pe_oi: 2000 },
      { strike: 24500, ce_oi: 3000, pe_oi: 4000 },
    ];
    expect(sumOi(rows, "pe")).toBe(6000);
  });

  it("returns 0 for an empty array", () => {
    expect(sumOi([], "ce")).toBe(0);
    expect(sumOi([], "pe")).toBe(0);
  });
});

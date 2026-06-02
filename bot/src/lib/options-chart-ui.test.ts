import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIONS_DASHBOARD_MODE,
  DEFAULT_OPTIONS_CHART_MODE,
  NSE_BAND_ROW_LIMIT,
  NSE_SESSION_MINUTE_COUNT,
  getPremiumDecayDataState,
  getPremiumDecayFeedBehavior,
  getPremiumDecayMetricValues,
  getOptionsChartVisibility,
  getPremiumDecayPlotClipRect,
  getPremiumDecaySvgWidth,
} from "./options-chart-ui";

describe("options chart selection", () => {
  it("opens on the live dashboard by default", () => {
    expect(DEFAULT_OPTIONS_DASHBOARD_MODE).toBe("live");
  });

  it("shows only the ATM premium decay chart by default", () => {
    expect(DEFAULT_OPTIONS_CHART_MODE).toBe("atm");
    expect(getOptionsChartVisibility(DEFAULT_OPTIONS_CHART_MODE)).toEqual({
      showAtm: true,
      showBandAverage: false,
    });
  });

  it("shows only the band average chart when selected", () => {
    expect(getOptionsChartVisibility("band-average")).toEqual({
      showAtm: false,
      showBandAverage: true,
    });
  });
});

describe("premium decay plot clipping", () => {
  it("keeps series rendering inside the axis plot rectangle", () => {
    expect(getPremiumDecayPlotClipRect()).toEqual({
      x: 68,
      y: 28,
      width: 904,
      height: 336,
    });
  });
});

describe("premium decay session scrolling", () => {
  it("retains every one-minute timestamp in the NSE session and all band rows", () => {
    expect(NSE_SESSION_MINUTE_COUNT).toBe(376);
    expect(NSE_BAND_ROW_LIMIT).toBe(4136);
  });

  it("renders a wider SVG for a complete session while preserving the base width for short charts", () => {
    expect(getPremiumDecaySvgWidth(120)).toBe(1000);
    expect(getPremiumDecaySvgWidth(NSE_SESSION_MINUTE_COUNT)).toBe(2945);
  });

  it("expands the plot clip rectangle with the scrollable SVG canvas", () => {
    expect(getPremiumDecayPlotClipRect(2945)).toEqual({
      x: 68,
      y: 28,
      width: 2849,
      height: 336,
    });
  });
});

describe("premium decay live-data state", () => {
  it("shows a waiting state instead of a demo curve when no live rows exist", () => {
    expect(getPremiumDecayDataState(0)).toBe("waiting");
    expect(getPremiumDecayDataState(1)).toBe("live");
  });

  it("provides a finite zero baseline while live rows are empty", () => {
    expect(getPremiumDecayMetricValues([])).toEqual([0]);
    expect(
      getPremiumDecayMetricValues([{ ceDecay: 3, chartPeDecay: -2 }]),
    ).toEqual([3, -2, 0]);
  });
});

describe("premium decay feed behavior", () => {
  it("keeps polling and realtime enabled for the live dashboard", () => {
    expect(getPremiumDecayFeedBehavior(true)).toEqual({
      pollIntervalMs: 30_000,
      subscribeToRealtime: true,
    });
  });

  it("loads historical sessions once without polling or realtime subscriptions", () => {
    expect(getPremiumDecayFeedBehavior(false)).toEqual({
      pollIntervalMs: null,
      subscribeToRealtime: false,
    });
  });
});

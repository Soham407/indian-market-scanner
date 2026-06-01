import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIONS_CHART_MODE,
  getOptionsChartVisibility,
  getPremiumDecayPlotClipRect,
} from "./options-chart-ui";

describe("options chart selection", () => {
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

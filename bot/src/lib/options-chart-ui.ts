export type OptionsChartMode = "atm" | "band-average";

export const DEFAULT_OPTIONS_CHART_MODE: OptionsChartMode = "atm";

export function getOptionsChartVisibility(mode: OptionsChartMode) {
  return {
    showAtm: mode === "atm",
    showBandAverage: mode === "band-average",
  };
}

export function getPremiumDecayPlotClipRect() {
  return {
    x: 68,
    y: 28,
    width: 904,
    height: 336,
  };
}

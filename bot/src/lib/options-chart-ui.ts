export type OptionsChartMode = "atm" | "band-average";

export const DEFAULT_OPTIONS_CHART_MODE: OptionsChartMode = "atm";
export const NSE_SESSION_MINUTE_COUNT = 376;
export const NSE_BAND_ROW_LIMIT = NSE_SESSION_MINUTE_COUNT * 11;

const BASE_SVG_WIDTH = 1000;
const BASE_VISIBLE_MINUTES = 120;
const PLOT_HORIZONTAL_MARGIN = 96;

export function getPremiumDecaySvgWidth(totalMinutes: number) {
  if (totalMinutes <= BASE_VISIBLE_MINUTES) return BASE_SVG_WIDTH;
  return PLOT_HORIZONTAL_MARGIN + Math.ceil((totalMinutes - 1) * ((BASE_SVG_WIDTH - PLOT_HORIZONTAL_MARGIN) / (BASE_VISIBLE_MINUTES - 1)));
}

export function getOptionsChartVisibility(mode: OptionsChartMode) {
  return {
    showAtm: mode === "atm",
    showBandAverage: mode === "band-average",
  };
}

export function getPremiumDecayPlotClipRect(svgWidth = BASE_SVG_WIDTH) {
  return {
    x: 68,
    y: 28,
    width: svgWidth - PLOT_HORIZONTAL_MARGIN,
    height: 336,
  };
}

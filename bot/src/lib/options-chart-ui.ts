export type OptionsDashboardMode = "live" | "historical";
export type OptionsChartMode = "atm" | "band-average";

export const DEFAULT_OPTIONS_DASHBOARD_MODE: OptionsDashboardMode = "live";
export const DEFAULT_OPTIONS_CHART_MODE: OptionsChartMode = "band-average";
export const NSE_SESSION_MINUTE_COUNT = 376;
export const NSE_BAND_ROW_LIMIT = NSE_SESSION_MINUTE_COUNT * 11;
export const PREMIUM_DECAY_REFRESH_INTERVAL_MS = 30_000;

const BASE_SVG_WIDTH = 1000;
const BASE_VISIBLE_MINUTES = 120;
const PLOT_HORIZONTAL_MARGIN = 96;

export function getPremiumDecaySvgWidth(totalMinutes: number) {
  if (totalMinutes <= BASE_VISIBLE_MINUTES) return BASE_SVG_WIDTH;
  return PLOT_HORIZONTAL_MARGIN + Math.ceil((totalMinutes - 1) * ((BASE_SVG_WIDTH - PLOT_HORIZONTAL_MARGIN) / (BASE_VISIBLE_MINUTES - 1)));
}

export function getPremiumDecayDataState(rowCount: number) {
  return rowCount > 0 ? "live" : "waiting";
}

export function getPremiumDecayFeedBehavior(live: boolean) {
  return {
    pollIntervalMs: live ? PREMIUM_DECAY_REFRESH_INTERVAL_MS : null,
    subscribeToRealtime: live,
  };
}

export function getPremiumDecayMetricValues(
  points: Array<{ ceDecay: number; chartPeDecay: number }>,
) {
  return points.length > 0
    ? points.flatMap((point) => [point.ceDecay, point.chartPeDecay, 0])
    : [0];
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

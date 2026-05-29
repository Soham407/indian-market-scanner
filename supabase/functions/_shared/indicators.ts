// Technical indicator library for the Chanakya daily scanner.
// All input arrays must be sorted oldest → newest.
// Returns NaN when data is insufficient.

export function sma(values: number[], period: number): number {
  if (values.length < period) return NaN;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Full EMA series (oldest → newest), seeded with SMA of first `period` values.
function emaFull(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function ema(values: number[], period: number): number {
  const s = emaFull(values, period);
  return s.length ? s[s.length - 1] : NaN;
}

// Wilder's smoothed average (used for RSI and ADX).
function wilderSmooth(values: number[], period: number): number[] {
  if (values.length < period) return [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out.push(prev);
  }
  return out;
}

export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  const gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  const ag = wilderSmooth(gains, period);
  const al = wilderSmooth(losses, period);
  if (!ag.length) return NaN;
  const g = ag[ag.length - 1], l = al[al.length - 1];
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

// ChartInk MACD(slow, fast, signal): parameters listed as (14,5,3) mean slow=14, fast=5.
// MACD Line = EMA(fast) – EMA(slow). Positive in uptrends (EMA(5) > EMA(14)).
export function macd(
  closes: number[], slowPeriod: number, fastPeriod: number, signalPeriod: number,
): { line: number; signalLine: number; histogram: number } {
  const nan = { line: NaN, signalLine: NaN, histogram: NaN };
  if (slowPeriod <= fastPeriod) return nan;
  const slow = emaFull(closes, slowPeriod);
  const fast = emaFull(closes, fastPeriod);
  const offset = slowPeriod - fastPeriod;
  if (!slow.length || fast.length <= offset) return nan;
  const macdLine: number[] = [];
  for (let i = 0; i < slow.length; i++) macdLine.push(fast[i + offset] - slow[i]);
  if (macdLine.length < signalPeriod) return nan;
  const sig = emaFull(macdLine, signalPeriod);
  if (!sig.length) return nan;
  const line = macdLine[macdLine.length - 1];
  const signalLine = sig[sig.length - 1];
  return { line, signalLine, histogram: line - signalLine };
}

export function adx(
  highs: number[], lows: number[], closes: number[], period = 14,
): { diPlus: number; diMinus: number } {
  const nan = { diPlus: NaN, diMinus: NaN };
  const n = closes.length;
  if (n < period * 2 + 1) return nan;
  const trs: number[] = [], dmP: number[] = [], dmM: number[] = [];
  for (let i = 1; i < n; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    const up = highs[i] - highs[i - 1], dn = lows[i - 1] - lows[i];
    dmP.push(up > dn && up > 0 ? up : 0);
    dmM.push(dn > up && dn > 0 ? dn : 0);
  }
  const atr = wilderSmooth(trs, period);
  const sP = wilderSmooth(dmP, period);
  const sM = wilderSmooth(dmM, period);
  const len = Math.min(atr.length, sP.length, sM.length);
  if (!len) return nan;
  return {
    diPlus: atr[len - 1] > 0 ? 100 * sP[len - 1] / atr[len - 1] : 0,
    diMinus: atr[len - 1] > 0 ? 100 * sM[len - 1] / atr[len - 1] : 0,
  };
}

export function stochasticFast(
  highs: number[], lows: number[], closes: number[], kPeriod: number, dPeriod: number,
): { k: number; d: number } {
  const nan = { k: NaN, d: NaN };
  const n = closes.length;
  if (n < kPeriod + dPeriod - 1) return nan;
  const kVals: number[] = [];
  for (let i = kPeriod - 1; i < n; i++) {
    const hh = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    kVals.push(hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100);
  }
  if (kVals.length < dPeriod) return nan;
  return {
    k: kVals[kVals.length - 1],
    d: kVals.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod,
  };
}

export function stochasticSlow(
  highs: number[], lows: number[], closes: number[], kPeriod: number, dPeriod: number,
): { k: number; d: number } {
  const nan = { k: NaN, d: NaN };
  const n = closes.length;
  if (n < kPeriod + dPeriod * 2 - 2) return nan;
  const fastK: number[] = [];
  for (let i = kPeriod - 1; i < n; i++) {
    const hh = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    fastK.push(hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100);
  }
  const slowK: number[] = [];
  for (let i = dPeriod - 1; i < fastK.length; i++) {
    slowK.push(fastK.slice(i - dPeriod + 1, i + 1).reduce((a, b) => a + b, 0) / dPeriod);
  }
  if (slowK.length < dPeriod) return nan;
  return {
    k: slowK[slowK.length - 1],
    d: slowK.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod,
  };
}

export function cci(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (closes.length < period) return NaN;
  const h = highs.slice(-period), l = lows.slice(-period), c = closes.slice(-period);
  const tps = h.map((hi, i) => (hi + l[i] + c[i]) / 3);
  const tp = tps[tps.length - 1];
  const mean = tps.reduce((a, b) => a + b, 0) / period;
  const dev = tps.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
  return dev === 0 ? 0 : (tp - mean) / (0.015 * dev);
}

// Standard Wilder Parabolic SAR (initial_af, step, max_af).
export function parabolicSar(
  highs: number[], lows: number[], closes: number[],
  initialAf = 0.02, step = 0.02, maxAf = 0.2,
): number {
  const n = highs.length;
  if (n < 3) return NaN;
  // Seed direction from first three closes.
  let bull = closes[2] >= closes[0];
  let sar = bull ? Math.min(lows[0], lows[1]) : Math.max(highs[0], highs[1]);
  let ep = bull ? Math.max(highs[0], highs[1]) : Math.min(lows[0], lows[1]);
  let af = initialAf;
  for (let i = 2; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (bull) {
      sar = Math.min(sar, lows[i - 1], i >= 2 ? lows[i - 2] : lows[i - 1]);
      if (lows[i] < sar) {
        bull = false; sar = ep; ep = lows[i]; af = initialAf;
      } else if (highs[i] > ep) { ep = highs[i]; af = Math.min(af + step, maxAf); }
    } else {
      sar = Math.max(sar, highs[i - 1], i >= 2 ? highs[i - 2] : highs[i - 1]);
      if (highs[i] > sar) {
        bull = true; sar = ep; ep = highs[i]; af = initialAf;
      } else if (lows[i] < ep) { ep = lows[i]; af = Math.min(af + step, maxAf); }
    }
  }
  return sar;
}

// StochRSI: Stochastic applied to the RSI series over `period` bars.
export function stochRsi(closes: number[], period = 14): number {
  if (closes.length < period * 2 + 1) return NaN;
  const rsiVals: number[] = [];
  for (let i = period; i < closes.length; i++) rsiVals.push(rsi(closes.slice(0, i + 1), period));
  if (rsiVals.length < period) return NaN;
  const slice = rsiVals.slice(-period);
  const lo = Math.min(...slice), hi = Math.max(...slice);
  if (hi === lo) return 50;
  return ((slice[slice.length - 1] - lo) / (hi - lo)) * 100;
}

export function mfi(
  highs: number[], lows: number[], closes: number[], volumes: number[], period = 14,
): number {
  const n = closes.length;
  if (n < period + 1) return NaN;
  const tps = highs.map((h, i) => (h + lows[i] + closes[i]) / 3);
  let pos = 0, neg = 0;
  for (let i = n - period; i < n; i++) {
    const rawMf = tps[i] * volumes[i];
    if (tps[i] > tps[i - 1]) pos += rawMf;
    else if (tps[i] < tps[i - 1]) neg += rawMf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

export function williamsR(
  highs: number[], lows: number[], closes: number[], period = 14,
): number {
  if (closes.length < period) return NaN;
  const hh = Math.max(...highs.slice(-period));
  const ll = Math.min(...lows.slice(-period));
  if (hh === ll) return -50;
  return ((hh - closes[closes.length - 1]) / (hh - ll)) * -100;
}

export interface IchimokuResult {
  conversion: number;
  base: number;
  spanA: number;
  spanB: number;
  cloudTop: number;
}

// Ichimoku(tenkan, kijun, senkou). Current cloud = values projected `senkou` periods ago.
// Requires at least kijun + senkou * 2 candles.
export function ichimoku(
  highs: number[], lows: number[],
  tenkan: number, kijun: number, senkou: number,
): IchimokuResult {
  const nan = { conversion: NaN, base: NaN, spanA: NaN, spanB: NaN, cloudTop: NaN };
  const n = highs.length;
  if (n < kijun + senkou * 2) return nan;
  const mid = (h: number[], l: number[], start: number, len: number) => {
    const hs = h.slice(start, start + len), ls = l.slice(start, start + len);
    return (Math.max(...hs) + Math.min(...ls)) / 2;
  };
  const conversion = mid(highs, lows, n - tenkan, tenkan);
  const base = mid(highs, lows, n - kijun, kijun);
  // Current Span A = (tenkan + kijun) computed `senkou` periods ago, projected forward to now.
  const tPast = mid(highs, lows, n - senkou - tenkan, tenkan);
  const bPast = mid(highs, lows, n - senkou - kijun, kijun);
  const spanA = (tPast + bPast) / 2;
  // Current Span B = midpoint of `senkou`-period range computed `senkou` periods ago.
  const spanB = mid(highs, lows, n - senkou * 2, senkou);
  return { conversion, base, spanA, spanB, cloudTop: Math.max(spanA, spanB) };
}

export type OiStrikeRow = { strike: number; ce_oi: number; pe_oi: number };
export type OiHighlight = { strike: number; oi: number } | null;
export type PcrClassification = "bullish" | "bearish" | "neutral";

export function computePcr(totalPeOi: number, totalCeOi: number): number | null {
  if (totalCeOi === 0) return null;
  return totalPeOi / totalCeOi;
}

export function classifyPcr(pcr: number): PcrClassification {
  if (pcr > 1.2) return "bullish";
  if (pcr < 0.8) return "bearish";
  return "neutral";
}

export function getHighestOiStrike(rows: OiStrikeRow[], side: "ce" | "pe"): OiHighlight {
  if (rows.length === 0) return null;
  const key = side === "ce" ? "ce_oi" : "pe_oi";
  let best = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][key] > best[key]) best = rows[i];
  }
  return { strike: best.strike, oi: best[key] };
}

export function getNiftyMidValue(high: number, low: number): number {
  return (high + low) / 2;
}

export function sumOi(rows: OiStrikeRow[], side: "ce" | "pe"): number {
  const key = side === "ce" ? "ce_oi" : "pe_oi";
  return rows.reduce((acc, row) => acc + row[key], 0);
}

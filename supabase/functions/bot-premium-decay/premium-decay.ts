export const PREMIUM_DECAY_SERIES_KEY = "NIFTY-ATM-WEEKLY";
export const PREMIUM_DECAY_BAND_SERIES_KEY = "NIFTY-BAND-WEEKLY";
export const NIFTY_STRIKE_STEP = 50;

export type AngelInstrument = {
  token: string;
  symbol: string;
  name: string;
  expiry: string;
  strike: string;
  exch_seg: string;
  instrumenttype: string;
};

export type OptionContract = {
  token: string;
  symbol: string;
  expiryDate: string;
  strike: number;
};

export type AtmOptionPair = {
  expiryDate: string;
  strike: number;
  ce: OptionContract;
  pe: OptionContract;
};

export type PremiumDecayBaseline = {
  ce_ltp: number | string;
  pe_ltp: number | string;
};

export type AngelLtpQuote = {
  symbolToken?: string;
  ltp?: number | string;
};

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseAngelExpiry(expiry: string): string | null {
  const normalized = expiry.trim().toUpperCase();
  if (!normalized) return null;

  const parsed = new Date(
    `${normalized.slice(2, 5)} ${normalized.slice(0, 2)}, ${
      normalized.slice(5)
    } UTC`,
  );
  return Number.isNaN(parsed.getTime()) ? null : toIsoDate(parsed);
}

function normalizeStrike(strike: string): number {
  const rawStrike = Number(strike);
  if (!Number.isFinite(rawStrike)) {
    throw new Error(`Invalid Angel One strike: ${strike}`);
  }
  return rawStrike / 100;
}

function buildCompletePairsByStrike(
  instruments: AngelInstrument[],
  now: Date,
): {
  expiryDate: string;
  byStrike: Map<number, { ce: OptionContract; pe: OptionContract }>;
} {
  const today = toIsoDate(now);
  const contracts = instruments
    .filter((instrument) =>
      instrument.exch_seg === "NFO" &&
      instrument.instrumenttype === "OPTIDX" &&
      instrument.name === "NIFTY"
    )
    .map((instrument) => {
      const expiryDate = parseAngelExpiry(instrument.expiry);
      const optionType = instrument.symbol.endsWith("CE")
        ? "CE"
        : instrument.symbol.endsWith("PE")
        ? "PE"
        : null;

      if (!expiryDate || !optionType || expiryDate < today) return null;

      return {
        optionType,
        contract: {
          token: instrument.token,
          symbol: instrument.symbol,
          expiryDate,
          strike: normalizeStrike(instrument.strike),
        },
      };
    })
    .filter((contract): contract is NonNullable<typeof contract> =>
      contract !== null
    );

  const nearestExpiry =
    contracts.map(({ contract }) => contract.expiryDate).sort()[0];

  if (!nearestExpiry) {
    throw new Error(
      "No active NIFTY OPTIDX contracts found in Angel One scrip master",
    );
  }

  const partial = new Map<
    number,
    { ce?: OptionContract; pe?: OptionContract }
  >();
  for (const { optionType, contract } of contracts) {
    if (contract.expiryDate !== nearestExpiry) continue;
    const pair = partial.get(contract.strike) ?? {};
    pair[optionType === "CE" ? "ce" : "pe"] = contract;
    partial.set(contract.strike, pair);
  }

  const byStrike = new Map<
    number,
    { ce: OptionContract; pe: OptionContract }
  >();
  for (const [strike, pair] of partial) {
    if (pair.ce && pair.pe) byStrike.set(strike, { ce: pair.ce, pe: pair.pe });
  }

  return { expiryDate: nearestExpiry, byStrike };
}

export function selectNearestAtmOptionPair(
  instruments: AngelInstrument[],
  underlyingLtp: number,
  now = new Date(),
): AtmOptionPair {
  const { expiryDate, byStrike } = buildCompletePairsByStrike(instruments, now);

  const nearestPair = [...byStrike.entries()]
    .sort(([leftStrike], [rightStrike]) =>
      Math.abs(leftStrike - underlyingLtp) -
      Math.abs(rightStrike - underlyingLtp)
    )[0];

  if (!nearestPair) {
    throw new Error(
      `No complete NIFTY CE/PE pair found for expiry ${expiryDate}`,
    );
  }

  const [strike, pair] = nearestPair;
  return { expiryDate, strike, ce: pair.ce, pe: pair.pe };
}

export function selectAtmBandPairs(
  instruments: AngelInstrument[],
  underlyingLtp: number,
  now = new Date(),
  sideCount = 5,
): AtmOptionPair[] {
  const { expiryDate, byStrike } = buildCompletePairsByStrike(instruments, now);

  const atmStrike = [...byStrike.keys()]
    .sort((a, b) =>
      Math.abs(a - underlyingLtp) - Math.abs(b - underlyingLtp)
    )[0];

  if (atmStrike === undefined) {
    throw new Error(
      `No complete NIFTY CE/PE pair found for expiry ${expiryDate}`,
    );
  }

  const result: AtmOptionPair[] = [];
  for (let offset = -sideCount; offset <= sideCount; offset++) {
    const strike = atmStrike + offset * NIFTY_STRIKE_STEP;
    const pair = byStrike.get(strike);
    if (pair) result.push({ expiryDate, strike, ce: pair.ce, pe: pair.pe });
  }

  return result;
}

export function collectOptionTokens(
  pair: AtmOptionPair,
  bandPairs: AtmOptionPair[],
): string[] {
  return [
    ...new Set([
      pair.ce.token,
      pair.pe.token,
      ...bandPairs.flatMap((
        bandPair,
      ) => [bandPair.ce.token, bandPair.pe.token]),
    ]),
  ];
}

export function indexBatchLtps(quotes: AngelLtpQuote[]): Map<string, number> {
  const byToken = new Map<string, number>();
  for (const quote of quotes) {
    const ltp = Number(quote.ltp);
    if (quote.symbolToken && Number.isFinite(ltp)) {
      byToken.set(String(quote.symbolToken), ltp);
    }
  }
  return byToken;
}

export function requireBatchLtp(
  byToken: Map<string, number>,
  token: string,
  symbol: string,
): number {
  const ltp = byToken.get(token);
  if (ltp === undefined) {
    throw new Error(`Angel One batch quote omitted ${symbol} (${token})`);
  }
  return ltp;
}

export function buildPremiumDecayPoint(
  sampledAt: Date,
  pair: AtmOptionPair,
  underlyingLtp: number,
  ceLtp: number,
  peLtp: number,
  baseline?: PremiumDecayBaseline | null,
  seriesKey = PREMIUM_DECAY_SERIES_KEY,
) {
  const baselineCeLtp = baseline ? Number(baseline.ce_ltp) : ceLtp;
  const baselinePeLtp = baseline ? Number(baseline.pe_ltp) : peLtp;

  return {
    series_key: seriesKey,
    instrument_symbol: "NIFTY",
    expiry_date: pair.expiryDate,
    strike: pair.strike,
    sampled_at: sampledAt.toISOString(),
    underlying_ltp: underlyingLtp,
    ce_ltp: ceLtp,
    pe_ltp: peLtp,
    ce_decay: ceLtp - baselineCeLtp,
    pe_decay: peLtp - baselinePeLtp,
  };
}

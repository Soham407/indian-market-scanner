export const PREMIUM_DECAY_SERIES_KEY = "NIFTY-ATM-WEEKLY";

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

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseAngelExpiry(expiry: string): string | null {
  const normalized = expiry.trim().toUpperCase();
  if (!normalized) return null;

  const parsed = new Date(`${normalized.slice(2, 5)} ${normalized.slice(0, 2)}, ${normalized.slice(5)} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : toIsoDate(parsed);
}

function normalizeStrike(strike: string): number {
  const rawStrike = Number(strike);
  if (!Number.isFinite(rawStrike)) {
    throw new Error(`Invalid Angel One strike: ${strike}`);
  }
  return rawStrike / 100;
}

export function selectNearestAtmOptionPair(
  instruments: AngelInstrument[],
  underlyingLtp: number,
  now = new Date(),
): AtmOptionPair {
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
    .filter((contract): contract is NonNullable<typeof contract> => contract !== null);

  const nearestExpiry = contracts
    .map(({ contract }) => contract.expiryDate)
    .sort()[0];

  if (!nearestExpiry) {
    throw new Error("No active NIFTY OPTIDX contracts found in Angel One scrip master");
  }

  const byStrike = new Map<number, { ce?: OptionContract; pe?: OptionContract }>();
  for (const { optionType, contract } of contracts) {
    if (contract.expiryDate !== nearestExpiry) continue;
    const pair = byStrike.get(contract.strike) ?? {};
    pair[optionType === "CE" ? "ce" : "pe"] = contract;
    byStrike.set(contract.strike, pair);
  }

  const nearestPair = [...byStrike.entries()]
    .filter((entry): entry is [number, { ce: OptionContract; pe: OptionContract }] =>
      Boolean(entry[1].ce && entry[1].pe)
    )
    .sort(([leftStrike], [rightStrike]) =>
      Math.abs(leftStrike - underlyingLtp) - Math.abs(rightStrike - underlyingLtp)
    )[0];

  if (!nearestPair) {
    throw new Error(`No complete NIFTY CE/PE pair found for expiry ${nearestExpiry}`);
  }

  const [strike, pair] = nearestPair;
  return { expiryDate: nearestExpiry, strike, ce: pair.ce, pe: pair.pe };
}

export function buildPremiumDecayPoint(
  sampledAt: Date,
  pair: AtmOptionPair,
  underlyingLtp: number,
  ceLtp: number,
  peLtp: number,
  baseline?: PremiumDecayBaseline | null,
) {
  const baselineCeLtp = baseline ? Number(baseline.ce_ltp) : ceLtp;
  const baselinePeLtp = baseline ? Number(baseline.pe_ltp) : peLtp;

  return {
    series_key: PREMIUM_DECAY_SERIES_KEY,
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

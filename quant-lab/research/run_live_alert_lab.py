#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd

try:
    import pandas_ta as ta
except Exception:  # pragma: no cover
    ta = None


REPO_ROOT = Path(__file__).resolve().parents[2]
DUCKDB_PATH = REPO_ROOT / "data" / "market_store.duckdb"
RAW_INTRADAY_DIR = REPO_ROOT / "quant-lab" / "data" / "raw" / "intraday"
REPORT_DIR = REPO_ROOT / "quant-lab" / "reports"

IST = "Asia/Kolkata"

BASE_RISK_AMOUNT = 1000.0
DEFAULT_RISK_MULTIPLIER = 0.25
MAX_RISK_MULTIPLIER = 1.5

ENTRY_SLIPPAGE_PCT = 0.0005
TARGET_EXIT_SLIPPAGE_PCT = 0.0005
STOP_EXIT_SLIPPAGE_PCT = 0.0010
EOD_EXIT_SLIPPAGE_PCT = 0.0005
BROKERAGE_PER_TRADE = 40.0
STATUTORY_FEE_PCT = 0.0005

STRESS_START = pd.Timestamp("2015-01-01", tz=IST)
DISCOVERY_START = pd.Timestamp("2020-01-01", tz=IST)
VALIDATION_START = pd.Timestamp("2022-01-01", tz=IST)
HOLDOUT_START = pd.Timestamp("2026-01-01", tz=IST)

MORNING_TRAP_START = 9 * 60 + 15
MORNING_TRAP_END = 10 * 60 + 15
OR_TRAP_START = 10 * 60 + 15
OR_TRAP_END = 13 * 60 + 30
OR_BREAKOUT_END = 14 * 60 + 30
OR_WINDOW_START = 9 * 60 + 15
OR_WINDOW_END = 9 * 60 + 30
BREAKOUT_CUTOFF = 12 * 60 + 30
MIN_AVG_MIN_VOLUME = 15_000
MIN_OR_RANGE_PCT = 0.003
MAX_OR_RANGE_PCT = 0.05

NIFTY50_SYMBOLS = {
    "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK",
    "BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV", "BPCL", "BHARTIARTL",
    "BRITANNIA", "CIPLA", "COALINDIA", "DIVISLAB", "DRREDDY",
    "EICHERMOT", "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE",
    "HEROMOTOCO", "HINDALCO", "HINDUNILVR", "ICICIBANK", "ITC",
    "INDUSINDBK", "INFY", "JSWSTEEL", "KOTAKBANK", "LTIM",
    "LT", "M&M", "MARUTI", "NTPC", "NESTLEIND",
    "ONGC", "POWERGRID", "RELIANCE", "SBILIFE", "SBIN",
    "SUNPHARMA", "TCS", "TATACONSUM", "TATAMOTORS", "TATASTEEL",
    "TECHM", "TITAN", "ULTRACEMCO", "UPL", "WIPRO",
}

OR_BREAKOUT_WHITELIST = {
    "INDUSINDBK",
    "RELIANCE",
    "TATASTEEL",
    "TITAN",
    "WIPRO",
}


@dataclass(frozen=True)
class CoverageRow:
    symbol: str
    intraday_timeframe: str
    intraday_rows: int
    daily_rows: int
    intraday_first: str | None
    intraday_last: str | None
    daily_first: str | None
    daily_last: str | None
    raw_holdout_5m: bool


def to_ist(ts: pd.Timestamp | str | datetime) -> pd.Timestamp:
    ts = pd.Timestamp(ts)
    if ts.tzinfo is None:
        return ts.tz_localize(IST)
    return ts.tz_convert(IST)


def report_dt(value: pd.Timestamp | datetime | str | None) -> str | None:
    if value is None:
        return None
    ts = pd.Timestamp(value)
    if ts.tzinfo is None:
        ts = ts.tz_localize(IST)
    return ts.isoformat()


def split_bucket(ts: pd.Timestamp) -> str:
    if ts < DISCOVERY_START:
        return "stress"
    if ts < VALIDATION_START:
        return "discovery"
    if ts < HOLDOUT_START:
        return "validation"
    return "holdout"


def parse_symbol_list(value: str) -> list[str]:
    return [item.strip().upper() for item in value.split(",") if item.strip()]


def list_raw_5m_symbols() -> set[str]:
    if not RAW_INTRADAY_DIR.exists():
        return set()
    return {path.stem.replace("_5m", "").upper() for path in RAW_INTRADAY_DIR.glob("*_5m.csv")}


def discover_symbols(
    con: duckdb.DuckDBPyConnection,
    universe: str,
    max_symbols: int,
    symbols: list[str] | None,
) -> list[str]:
    if symbols:
        return symbols

    rows = con.execute(
        """
        select
          symbol,
          max(case when timeframe = '3m' then rows else null end) as rows_3m,
          max(case when timeframe = '1d' then rows else null end) as rows_1d
        from market_candle_summary
        group by symbol
        order by coalesce(rows_3m, 0) desc, coalesce(rows_1d, 0) desc, symbol
        """
    ).fetchall()

    if universe == "nifty50":
        rows = [row for row in rows if row[0] in NIFTY50_SYMBOLS]
    else:
        rows = [row for row in rows if (row[1] or 0) >= 5000 and (row[2] or 0) >= 500]

    return [row[0] for row in rows[:max_symbols]]


def load_frame(con: duckdb.DuckDBPyConnection, symbol: str, timeframe: str) -> pd.DataFrame | None:
    query = """
        select timestamp_ist as timestamp, open, high, low, close, volume
        from market_candles
        where symbol = ? and timeframe = ?
        order by timestamp_ist
    """
    df = con.execute(query, [symbol, timeframe]).df()
    if df.empty:
        return None
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=False)
    if df["timestamp"].dt.tz is None:
        df["timestamp"] = df["timestamp"].dt.tz_localize(IST)
    else:
        df["timestamp"] = df["timestamp"].dt.tz_convert(IST)
    df["symbol"] = symbol
    return standardize_frame(df)


def load_raw_5m_frame(symbol: str) -> pd.DataFrame | None:
    path = RAW_INTRADAY_DIR / f"{symbol}_5m.csv"
    if not path.exists():
        return None

    df = pd.read_csv(path)
    if df.empty:
        return None

    df.columns = [col.strip().lower() for col in df.columns]
    time_col = next((c for c in df.columns if c in {"date", "datetime", "timestamp", "time"}), None)
    if time_col is None:
        return None

    rename_map = {"open": "open", "high": "high", "low": "low", "close": "close", "volume": "volume"}
    df = df.rename(columns=rename_map)
    required = ["open", "high", "low", "close", "volume"]
    if any(col not in df.columns for col in required):
        return None

    df["timestamp"] = pd.to_datetime(df[time_col], utc=True, errors="coerce")
    df = df[df["timestamp"].notna()].copy()
    df["timestamp"] = df["timestamp"].dt.tz_convert(IST)
    for col in required:
      df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=required)
    df["symbol"] = symbol
    return standardize_frame(df[["timestamp", "symbol", "open", "high", "low", "close", "volume"]])


def aggregate_daily_frame(frame: pd.DataFrame | None, symbol: str) -> pd.DataFrame | None:
    if frame is None or frame.empty:
        return None
    df = frame.copy()
    if "timestamp" not in df.columns:
        return None
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=False)
    if df["timestamp"].dt.tz is None:
        df["timestamp"] = df["timestamp"].dt.tz_localize(IST)
    else:
        df["timestamp"] = df["timestamp"].dt.tz_convert(IST)
    grouped = df.groupby(df["timestamp"].dt.normalize(), sort=True)
    daily = grouped.agg(
        timestamp=("timestamp", "first"),
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
    ).reset_index(drop=True)
    daily["symbol"] = symbol
    return standardize_frame(daily[["timestamp", "symbol", "open", "high", "low", "close", "volume"]])


def rsi_series(closes: pd.Series, period: int = 14) -> pd.Series:
    delta = closes.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def atr_series(highs: pd.Series, lows: pd.Series, closes: pd.Series, period: int = 14) -> pd.Series:
    prev_close = closes.shift(1)
    tr = pd.concat(
        [
            (highs - lows),
            (highs - prev_close).abs(),
            (lows - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.rolling(period).mean()


def passes_or_breakout_gate(daily_frame: pd.DataFrame | None, day: pd.Timestamp) -> bool:
    if daily_frame is None or daily_frame.empty:
        return False
    frame = daily_frame[daily_frame["timestamp"].dt.normalize() <= day.normalize()].copy()
    if len(frame) < 21:
        return False

    latest = frame.iloc[-1]
    prior = frame.iloc[-2]
    history = frame.iloc[:-1]
    ema5 = history["close"].ewm(span=5, adjust=False).mean().iloc[-1]
    rsi_val = rsi_series(history["close"], 14).iloc[-1]
    atr_val = atr_series(history["high"], history["low"], history["close"], 14).iloc[-1]
    if any(pd.isna(value) for value in [latest["open"], latest["close"], prior["close"], ema5, rsi_val, atr_val]):
        return False

    gap_pct = (float(latest["open"]) - float(prior["close"])) / float(prior["close"])
    return (
        float(latest["close"]) > float(ema5)
        and float(rsi_val) > 55
        and gap_pct <= -0.005
        and (float(atr_val) / float(latest["close"])) > 0.02
    )


def standardize_frame(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out = out.sort_values("timestamp").drop_duplicates(subset=["timestamp"], keep="last").reset_index(drop=True)
    out["timestamp"] = pd.to_datetime(out["timestamp"]).dt.tz_convert(IST)
    if "symbol" not in out.columns:
        out["symbol"] = None
    out["session_date"] = out["timestamp"].dt.normalize()
    out["time_minutes"] = out["timestamp"].dt.hour * 60 + out["timestamp"].dt.minute
    grouped = out.groupby("session_date", sort=False)

    typical_price = (out["high"] + out["low"] + out["close"]) / 3.0
    out["session_volume"] = grouped["volume"].cumsum()
    out["cum_tp_vol"] = (typical_price * out["volume"]).groupby(out["session_date"]).cumsum()
    out["cum_volume"] = out["session_volume"].replace(0, np.nan)
    out["vwap"] = out["cum_tp_vol"] / out["cum_volume"]
    out["session_high"] = grouped["high"].cummax()
    out["session_low"] = grouped["low"].cummin()
    out["bar_index"] = grouped.cumcount()

    daily = grouped.agg(
        day_open=("open", "first"),
        day_high=("high", "max"),
        day_low=("low", "min"),
        day_close=("close", "last"),
        day_volume=("volume", "sum"),
    )
    daily["prev_high"] = daily["day_high"].shift(1)
    daily["prev_low"] = daily["day_low"].shift(1)
    daily["prev_close"] = daily["day_close"].shift(1)
    daily["prev_open"] = daily["day_open"].shift(1)
    daily["prev_volume"] = daily["day_volume"].shift(1)
    out = out.join(daily[["prev_high", "prev_low", "prev_close", "prev_open", "prev_volume"]], on="session_date")
    return out


def apply_entry_slippage(side: str, trigger_price: float) -> float:
    if side == "long":
        return round(trigger_price * (1 + ENTRY_SLIPPAGE_PCT), 4)
    return round(trigger_price * (1 - ENTRY_SLIPPAGE_PCT), 4)


def apply_exit_slippage(side: str, exit_price: float, exit_reason: str) -> float:
    if exit_reason == "stop":
        slip = STOP_EXIT_SLIPPAGE_PCT
    elif exit_reason == "target":
        slip = TARGET_EXIT_SLIPPAGE_PCT
    else:
        slip = EOD_EXIT_SLIPPAGE_PCT
    if side == "long":
        return round(exit_price * (1 - slip), 4)
    return round(exit_price * (1 + slip), 4)


def calculate_shares(risk_amount: float, entry_price: float, stop_price: float) -> int:
    risk_per_share = abs(entry_price - stop_price)
    if risk_per_share <= 0:
        return 0
    return math.floor(risk_amount / risk_per_share)


def risk_target(trigger_price: float, stop_price: float, side: str, target_mult: float) -> float:
    risk = abs(trigger_price - stop_price)
    if side == "long":
        return round(trigger_price + (risk * target_mult), 4)
    return round(trigger_price - (risk * target_mult), 4)


def compute_pnl(side: str, entry_price: float, exit_price: float, shares: int) -> tuple[float, float, float]:
    gross = (exit_price - entry_price) * shares if side == "long" else (entry_price - exit_price) * shares
    statutory = abs(exit_price * shares * STATUTORY_FEE_PCT)
    net = gross - statutory - BROKERAGE_PER_TRADE
    return gross, statutory, net


def trade_mfe_mae(day_df: pd.DataFrame, signal_idx: int, side: str, entry_price: float) -> tuple[float | None, float | None]:
    future = day_df.iloc[signal_idx + 1 :]
    if future.empty:
        return None, None
    if side == "long":
        return float(future["high"].max() - entry_price), float(entry_price - future["low"].min())
    return float(entry_price - future["low"].min()), float(future["high"].max() - entry_price)


def simulate_trade(
    day_df: pd.DataFrame,
    signal_idx: int,
    side: str,
    stop_price: float,
    target_price: float,
    strategy: str,
    signal_reason: str,
    risk_multiplier: float = DEFAULT_RISK_MULTIPLIER,
) -> dict[str, Any] | None:
    if signal_idx >= len(day_df):
        return None

    signal_row = day_df.iloc[signal_idx]
    trigger_price = float(signal_row["close"])
    entry_price = apply_entry_slippage(side, trigger_price)
    risk_amount = BASE_RISK_AMOUNT * min(risk_multiplier, MAX_RISK_MULTIPLIER)
    shares = calculate_shares(risk_amount, entry_price, stop_price)
    if shares <= 0:
        return None

    future = day_df.iloc[signal_idx + 1 :]
    exit_price = None
    exit_reason = None
    exit_time = None

    for _, candle in future.iterrows():
        if side == "long":
            if candle["low"] <= stop_price:
                exit_price = stop_price
                exit_reason = "stop"
                exit_time = candle["timestamp"]
                break
            if candle["high"] >= target_price:
                exit_price = target_price
                exit_reason = "target"
                exit_time = candle["timestamp"]
                break
        else:
            if candle["high"] >= stop_price:
                exit_price = stop_price
                exit_reason = "stop"
                exit_time = candle["timestamp"]
                break
            if candle["low"] <= target_price:
                exit_price = target_price
                exit_reason = "target"
                exit_time = candle["timestamp"]
                break

    if exit_price is None:
        if future.empty:
            exit_time = signal_row["timestamp"]
            exit_price = float(signal_row["close"])
        else:
            last = future.iloc[-1]
            exit_time = last["timestamp"]
            exit_price = float(last["close"])
        exit_reason = "eod"

    exit_price = apply_exit_slippage(side, float(exit_price), exit_reason)
    gross_pnl, statutory_charges, net_pnl = compute_pnl(side, entry_price, exit_price, shares)
    duration_minutes = int(max(0, round((pd.Timestamp(exit_time) - pd.Timestamp(signal_row["timestamp"])).total_seconds() / 60)))
    mfe, mae = trade_mfe_mae(day_df, signal_idx, side, entry_price)

    return {
        "strategy": strategy,
        "signal_reason": signal_reason,
        "symbol": signal_row["symbol"],
        "side": side,
        "entry_time": report_dt(signal_row["timestamp"]),
        "exit_time": report_dt(exit_time),
        "exit_reason": exit_reason,
        "trigger_price": round(trigger_price, 4),
        "entry_price": round(entry_price, 4),
        "exit_price": round(exit_price, 4),
        "stop_loss_price": round(stop_price, 4),
        "target_price": round(target_price, 4),
        "shares": shares,
        "risk_amount": round(risk_amount, 4),
        "gross_pnl": round(gross_pnl, 4),
        "statutory_charges": round(statutory_charges, 4),
        "brokerage": BROKERAGE_PER_TRADE,
        "net_pnl": round(net_pnl, 4),
        "duration_minutes": duration_minutes,
        "mfe": None if mfe is None else round(mfe, 4),
        "mae": None if mae is None else round(mae, 4),
    }


def first_trade(trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not trades:
        return []
    def sort_key(row: dict[str, Any]) -> tuple[Any, Any]:
        ts = row.get("entry_time") or row.get("signal_time")
        return (pd.Timestamp(ts), row.get("side", ""))

    return [sorted(trades, key=sort_key)[0]]


def signal_morning_trap(day_df: pd.DataFrame, displacement: float, side: str) -> list[dict[str, Any]]:
    start = MORNING_TRAP_START
    end = MORNING_TRAP_END
    window = day_df[(day_df["time_minutes"] >= start) & (day_df["time_minutes"] < end)]
    if window.empty:
        return []

    candidates: list[dict[str, Any]] = []
    for idx, row in window.iterrows():
        prev_high = row["prev_high"]
        prev_low = row["prev_low"]
        vwap = row["vwap"]
        if pd.isna(prev_high) or pd.isna(prev_low) or pd.isna(vwap):
            continue
        if side == "short":
            swept = row["session_high"] >= prev_high
            trapped = row["close"] < prev_high
            extended = row["close"] > vwap * (1 + displacement)
            if swept and trapped and extended:
                trigger = float(row["close"])
                stop = trigger * 1.01
                target = float(vwap)
                candidates.append(
                    {
                        "signal_idx": idx,
                        "signal_time": row["timestamp"],
                        "side": "short",
                        "stop_price": stop,
                        "target_price": target,
                        "signal_reason": "pdh_trap_short",
                    }
                )
        else:
            swept = row["session_low"] <= prev_low
            trapped = row["close"] > prev_low
            extended = row["close"] < vwap * (1 - displacement)
            if swept and trapped and extended:
                trigger = float(row["close"])
                stop = trigger * 0.99
                target = float(vwap)
                candidates.append(
                    {
                        "signal_idx": idx,
                        "signal_time": row["timestamp"],
                        "side": "long",
                        "stop_price": stop,
                        "target_price": target,
                        "signal_reason": "pdl_bounce_long",
                    }
                )
    return candidates


def strategy_pdh_trap(day_df: pd.DataFrame, displacement: float = 0.0075) -> list[dict[str, Any]]:
    candidates = signal_morning_trap(day_df, displacement=displacement, side="short")
    return [simulate_trade(day_df, c["signal_idx"], c["side"], c["stop_price"], c["target_price"], "pdh_trap", c["signal_reason"]) for c in first_trade(candidates)] if candidates else []


def strategy_pdl_bounce(day_df: pd.DataFrame, displacement: float = 0.0075) -> list[dict[str, Any]]:
    candidates = signal_morning_trap(day_df, displacement=displacement, side="long")
    return [simulate_trade(day_df, c["signal_idx"], c["side"], c["stop_price"], c["target_price"], "pdl_bounce", c["signal_reason"]) for c in first_trade(candidates)] if candidates else []


def strategy_or_trap(day_df: pd.DataFrame, displacement: float = 0.0075) -> list[dict[str, Any]]:
    or_window = day_df[(day_df["time_minutes"] >= OR_WINDOW_START) & (day_df["time_minutes"] < OR_WINDOW_END)]
    if or_window.empty:
        return []
    or_high = float(or_window["high"].max())
    or_low = float(or_window["low"].min())
    if or_high <= or_low:
        return []

    window = day_df[(day_df["time_minutes"] >= OR_TRAP_START) & (day_df["time_minutes"] <= OR_TRAP_END)]
    if window.empty:
        return []

    candidates: list[dict[str, Any]] = []
    for idx, row in window.iterrows():
        vwap = row["vwap"]
        if pd.isna(vwap):
            continue
        if row["session_high"] > or_high and row["close"] < or_high and row["close"] > vwap * (1 + displacement):
            trigger = float(row["close"])
            candidates.append(
                {
                    "signal_idx": idx,
                    "signal_time": row["timestamp"],
                    "side": "short",
                    "stop_price": trigger * 1.01,
                    "target_price": float(vwap),
                    "signal_reason": "or_failed_breakout_short",
                }
            )
        if row["session_low"] < or_low and row["close"] > or_low and row["close"] < vwap * (1 - displacement):
            trigger = float(row["close"])
            candidates.append(
                {
                    "signal_idx": idx,
                    "signal_time": row["timestamp"],
                    "side": "long",
                    "stop_price": trigger * 0.99,
                    "target_price": float(vwap),
                    "signal_reason": "or_failed_breakdown_long",
                }
            )

    if not candidates:
        return []

    chosen = first_trade(candidates)[0]
    return [simulate_trade(day_df, chosen["signal_idx"], chosen["side"], chosen["stop_price"], chosen["target_price"], "or_trap", chosen["signal_reason"])]


def strategy_or_breakout(day_df: pd.DataFrame) -> list[dict[str, Any]]:
    or_window = day_df[(day_df["time_minutes"] >= OR_WINDOW_START) & (day_df["time_minutes"] < OR_WINDOW_END)]
    if or_window.empty:
        return []
    or_high = float(or_window["high"].max())
    or_low = float(or_window["low"].min())
    or_range = or_high - or_low
    if or_range <= 0:
        return []

    window = day_df[(day_df["time_minutes"] >= OR_TRAP_START) & (day_df["time_minutes"] <= OR_BREAKOUT_END)]
    if window.empty:
        return []

    candidates: list[dict[str, Any]] = []
    for idx, row in window.iterrows():
        vwap = row["vwap"]
        if pd.isna(vwap):
            continue
        if row["close"] > or_high and row["close"] > vwap and row["close"] >= row["session_high"] * 0.995:
            dist_pct = ((row["close"] - or_high) / or_high) * 100
            if dist_pct < 2.0:
                trigger = float(row["close"])
                candidates.append(
                    {
                        "signal_idx": idx,
                        "signal_time": row["timestamp"],
                        "side": "long",
                        "stop_price": trigger * 0.99,
                        "target_price": round(trigger + (or_high - or_low) * 1.5, 4),
                        "signal_reason": "or_breakout_long",
                    }
                )
        if row["close"] < or_low and row["close"] < vwap and row["close"] <= row["session_low"] * 1.005:
            dist_pct = ((or_low - row["close"]) / or_low) * 100
            if dist_pct < 2.0:
                trigger = float(row["close"])
                candidates.append(
                    {
                        "signal_idx": idx,
                        "signal_time": row["timestamp"],
                        "side": "short",
                        "stop_price": trigger * 1.01,
                        "target_price": round(trigger - (or_high - or_low) * 1.5, 4),
                        "signal_reason": "or_breakout_short",
                    }
                )

    if not candidates:
        return []

    chosen = first_trade(candidates)[0]
    return [simulate_trade(day_df, chosen["signal_idx"], chosen["side"], chosen["stop_price"], chosen["target_price"], "or_breakout", chosen["signal_reason"])]


def strategy_orb_breakout(day_df: pd.DataFrame) -> list[dict[str, Any]]:
    or_window = day_df[(day_df["time_minutes"] >= OR_WINDOW_START) & (day_df["time_minutes"] < OR_WINDOW_END)]
    if or_window.empty:
        return []

    or_high = float(or_window["high"].max())
    or_low = float(or_window["low"].min())
    or_range = or_high - or_low
    if or_range <= 0:
        return []

    mid_price = (or_high + or_low) / 2.0
    or_range_pct = or_range / mid_price
    if or_range_pct < MIN_OR_RANGE_PCT or or_range_pct > MAX_OR_RANGE_PCT:
        return []

    cutoff = day_df[(day_df["time_minutes"] >= OR_WINDOW_END) & (day_df["time_minutes"] <= BREAKOUT_CUTOFF)]
    if cutoff.empty:
        return []

    market_minutes_elapsed = max(1, int(cutoff.iloc[0]["time_minutes"] - OR_WINDOW_START))
    candidates: list[dict[str, Any]] = []
    for idx, row in cutoff.iterrows():
        session_minutes = max(1, int(row["time_minutes"] - OR_WINDOW_START))
        avg_min_vol = float(row["session_volume"]) / session_minutes if row["session_volume"] else 0.0
        if avg_min_vol < MIN_AVG_MIN_VOLUME:
            continue
        vwap = row["vwap"]
        if pd.isna(vwap):
            continue

        long_trigger = or_high * (1 + 0.003)
        short_trigger = or_low * (1 - 0.003)
        if row["close"] > long_trigger:
            candidates.append(
                {
                    "signal_idx": idx,
                    "signal_time": row["timestamp"],
                    "side": "long",
                    "stop_price": or_low,
                    "target_price": round(row["close"] * 1.0005 + or_range * 1.5, 4),
                    "signal_reason": "orb_breakout_long",
                }
            )
        elif row["close"] < short_trigger:
            candidates.append(
                {
                    "signal_idx": idx,
                    "signal_time": row["timestamp"],
                    "side": "short",
                    "stop_price": or_high,
                    "target_price": round(row["close"] * 0.9995 - or_range * 1.5, 4),
                    "signal_reason": "orb_breakout_short",
                }
            )

    if not candidates:
        return []

    chosen = first_trade(candidates)[0]
    trigger_price = float(day_df.iloc[chosen["signal_idx"]]["close"])
    entry_price = apply_entry_slippage(chosen["side"], trigger_price)
    if chosen["side"] == "long":
        target_price = round(entry_price + or_range * 1.5, 4)
    else:
        target_price = round(entry_price - or_range * 1.5, 4)
    return [simulate_trade(day_df, chosen["signal_idx"], chosen["side"], chosen["stop_price"], target_price, "orb_breakout", chosen["signal_reason"])]


def build_ichimoku(high: pd.Series, low: pd.Series) -> pd.DataFrame:
    conversion = (high.rolling(5).max() + low.rolling(5).min()) / 2.0
    base = (high.rolling(14).max() + low.rolling(14).min()) / 2.0
    span_a = ((conversion + base) / 2.0).shift(26)
    span_b = ((high.rolling(26).max() + low.rolling(26).min()) / 2.0).shift(26)
    cloud_top = pd.concat([span_a, span_b], axis=1).max(axis=1)
    return pd.DataFrame({"conversion": conversion, "base": base, "span_a": span_a, "span_b": span_b, "cloud_top": cloud_top})


def strategy_chanakya_bullish(day_df: pd.DataFrame) -> list[dict[str, Any]]:
    if ta is None or len(day_df) < 70:
        return []

    closes = day_df["close"].astype(float)
    highs = day_df["high"].astype(float)
    lows = day_df["low"].astype(float)
    volumes = day_df["volume"].astype(float)

    macd_df = ta.macd(closes, fast=5, slow=14, signal=3)
    adx_df = ta.adx(highs, lows, closes, length=14)
    stoch_fast = ta.stoch(highs, lows, closes, k=5, d=3, smooth_k=3)
    stoch_slow = ta.stoch(highs, lows, closes, k=5, d=3, smooth_k=1)
    rsi_series = ta.rsi(closes, length=14)
    ema6 = ta.ema(closes, length=6)
    cci_series = ta.cci(highs, lows, closes, length=14)
    psar_df = ta.psar(highs, lows, closes, af=0.02, max_af=0.2)
    stochrsi_df = ta.stochrsi(closes, length=14)
    mfi_series = ta.mfi(highs, lows, closes, volumes, length=14)
    willr_series = ta.willr(highs, lows, closes, length=14)
    ichi = build_ichimoku(highs, lows)

    if any(frame is None for frame in [macd_df, adx_df, stoch_fast, stoch_slow, rsi_series, ema6, cci_series, psar_df, stochrsi_df, mfi_series, willr_series]):
        return []

    day_df = day_df.copy()
    day_df["macd_line"] = macd_df.iloc[:, 0]
    day_df["macd_signal"] = macd_df.iloc[:, 1]
    day_df["macd_hist"] = macd_df.iloc[:, 2]
    day_df["di_plus"] = adx_df.iloc[:, 1]
    day_df["di_minus"] = adx_df.iloc[:, 2]
    day_df["stoch_fast_k"] = stoch_fast.iloc[:, 0]
    day_df["stoch_fast_d"] = stoch_fast.iloc[:, 1]
    day_df["stoch_slow_k"] = stoch_slow.iloc[:, 0]
    day_df["stoch_slow_d"] = stoch_slow.iloc[:, 1]
    day_df["rsi"] = rsi_series
    day_df["ema6"] = ema6
    day_df["cci"] = cci_series
    psar_cols = [col for col in psar_df.columns if col.startswith("PSAR")]
    if psar_cols:
        day_df["psar"] = psar_df[psar_cols].bfill(axis=1).iloc[:, 0]
    else:
        day_df["psar"] = np.nan
    stochrsi_cols = [col for col in stochrsi_df.columns if "STOCHRSIk" in col]
    if stochrsi_cols:
        day_df["stochrsi"] = stochrsi_df[stochrsi_cols[0]]
    else:
        day_df["stochrsi"] = np.nan
    day_df["mfi"] = mfi_series
    day_df["willr"] = willr_series
    day_df = day_df.join(ichi)

    last = day_df.iloc[-1]
    conditions = [
        pd.notna(last["macd_line"]) and pd.notna(last["macd_signal"]) and last["macd_line"] >= last["macd_signal"],
        pd.notna(last["di_plus"]) and pd.notna(last["di_minus"]) and last["di_plus"] >= last["di_minus"],
        pd.notna(last["stoch_slow_k"]) and pd.notna(last["stoch_slow_d"]) and last["stoch_slow_k"] >= last["stoch_slow_d"],
        pd.notna(last["stoch_fast_k"]) and pd.notna(last["stoch_fast_d"]) and last["stoch_fast_k"] >= last["stoch_fast_d"],
        pd.notna(last["macd_hist"]) and last["macd_hist"] > 0,
        pd.notna(last["rsi"]) and last["rsi"] >= 70,
        pd.notna(last["ema6"]) and last["close"] >= last["ema6"],
        pd.notna(last["cci"]) and last["cci"] > 0,
        pd.notna(last["psar"]) and last["close"] > last["psar"],
        pd.notna(last["stochrsi"]) and last["stochrsi"] >= 80,
        pd.notna(last["mfi"]) and last["mfi"] >= 80,
        pd.notna(last["willr"]) and last["willr"] >= -20,
        pd.notna(last["conversion"]) and pd.notna(last["base"]) and last["conversion"] >= last["base"],
        pd.notna(last["span_a"]) and pd.notna(last["span_b"]) and last["span_a"] >= last["span_b"],
        pd.notna(last["cloud_top"]) and last["close"] >= last["cloud_top"],
    ]
    if not all(conditions):
        return []

    signal_time = last["timestamp"]
    trigger_price = float(last["close"])
    stop_price = round(trigger_price * 0.97, 4)
    target_price = round(trigger_price * 1.06, 4)
    trade = simulate_trade(day_df, len(day_df) - 1, "long", stop_price, target_price, "chanakya_bullish", "chanakya_bullish")
    return [trade] if trade else []


def summarise_trades(trades: list[dict[str, Any]]) -> dict[str, Any]:
    if not trades:
        return {
            "trade_count": 0,
            "wins": 0,
            "losses": 0,
            "flat": 0,
            "gross_pnl": 0.0,
            "net_pnl": 0.0,
            "charges": 0.0,
            "win_rate": 0.0,
            "profit_factor": None,
            "expectancy": 0.0,
            "average_r": None,
            "max_drawdown": 0.0,
            "best_trade": None,
            "worst_trade": None,
        }

    df = pd.DataFrame(trades)
    gross_pnl = float(df["gross_pnl"].sum())
    net_pnl = float(df["net_pnl"].sum())
    charges = float((df["brokerage"] + df["statutory_charges"]).sum())
    wins = int((df["net_pnl"] > 0).sum())
    losses = int((df["net_pnl"] < 0).sum())
    flat = int((df["net_pnl"] == 0).sum())
    win_rate = wins / len(df) if len(df) else 0.0
    gross_wins = float(df.loc[df["net_pnl"] > 0, "net_pnl"].sum())
    gross_losses = abs(float(df.loc[df["net_pnl"] < 0, "net_pnl"].sum()))
    profit_factor = None if gross_losses == 0 else gross_wins / gross_losses
    expectancy = net_pnl / len(df)
    if "risk_amount" in df and (df["risk_amount"] > 0).any():
        valid = df["risk_amount"] > 0
        average_r = float((df.loc[valid, "net_pnl"] / df.loc[valid, "risk_amount"]).mean())
    else:
        average_r = None
    equity = df["net_pnl"].cumsum()
    peak = equity.cummax()
    max_drawdown = float((peak - equity).max())
    best_idx = df["net_pnl"].idxmax()
    worst_idx = df["net_pnl"].idxmin()
    best_trade = df.loc[best_idx, ["symbol", "side", "net_pnl", "exit_reason"]].to_dict()
    worst_trade = df.loc[worst_idx, ["symbol", "side", "net_pnl", "exit_reason"]].to_dict()
    return {
        "trade_count": int(len(df)),
        "wins": wins,
        "losses": losses,
        "flat": flat,
        "gross_pnl": round(gross_pnl, 4),
        "net_pnl": round(net_pnl, 4),
        "charges": round(charges, 4),
        "win_rate": round(win_rate, 4),
        "profit_factor": None if profit_factor is None else round(profit_factor, 4),
        "expectancy": round(expectancy, 4),
        "average_r": None if average_r is None else round(average_r, 4),
        "max_drawdown": round(max_drawdown, 4),
        "best_trade": best_trade,
        "worst_trade": worst_trade,
    }


def split_trades(trades: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    buckets = {"stress": [], "discovery": [], "validation": [], "holdout": []}
    for trade in trades:
        buckets[split_bucket(pd.Timestamp(trade["entry_time"]))].append(trade)
    return buckets


def build_yearly_breakdown(trades: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = {}
    for trade in trades:
        year = pd.Timestamp(trade["entry_time"]).year
        buckets.setdefault(str(year), []).append(trade)
    return {year: summarise_trades(items) for year, items in sorted(buckets.items())}


def recommendation_for(summary_by_split: dict[str, dict[str, Any]], require_holdout: bool) -> tuple[str, str, float]:
    validation = summary_by_split.get("validation", summarise_trades([]))
    holdout = summary_by_split.get("holdout", summarise_trades([]))
    discovery = summary_by_split.get("discovery", summarise_trades([]))
    validation_pf = validation.get("profit_factor") or 0.0
    holdout_pf = holdout.get("profit_factor") or 0.0
    validation_net = validation.get("net_pnl") or 0.0
    validation_count = validation.get("trade_count") or 0
    holdout_net = holdout.get("net_pnl") or 0.0
    discovery_pf = discovery.get("profit_factor") or 0.0

    score = (
        validation_net
        + 0.5 * holdout_net
        + 1000.0 * (validation_pf - 1.0)
        + 500.0 * (holdout_pf - 1.0)
        + 200.0 * (discovery_pf - 1.0)
    )

    if require_holdout:
        if validation_count >= 40 and validation_net > 0 and validation_pf >= 1.15 and holdout_pf >= 1.0:
            return "paper_live_small", "Validation is positive and holdout is not breaking down.", score
        if validation_count >= 25 and validation_net > 0 and validation_pf >= 1.05:
            return "shadow", "Validation is positive but not yet strong enough for live sizing.", score
        return "disabled", "Did not clear the validation thresholds.", score

    if validation_count >= 40 and validation_net > 0 and validation_pf >= 1.15:
        return "paper_live_small", "Validation is positive on the available data.", score
    if validation_count >= 25 and validation_net > 0 and validation_pf >= 1.05:
        return "shadow", "Validation is positive but not yet strong enough for live sizing.", score
    return "disabled", "Did not clear the validation thresholds.", score


def run_intraday_family(
    day_df: pd.DataFrame,
    family: str,
    variant: dict[str, Any],
) -> list[dict[str, Any]]:
    if family == "pdh_trap":
        return strategy_pdh_trap(day_df, displacement=float(variant.get("displacement", 0.0075)))
    if family == "pdl_bounce":
        return strategy_pdl_bounce(day_df, displacement=float(variant.get("displacement", 0.0075)))
    if family == "or_trap":
        return strategy_or_trap(day_df, displacement=float(variant.get("displacement", 0.0075)))
    if family == "or_breakout":
        return strategy_or_breakout(day_df)
    if family == "orb_breakout":
        return strategy_orb_breakout(day_df)
    if family == "chanakya_bullish":
        return strategy_chanakya_bullish(day_df)
    return []


def run_research(
    duckdb_path: Path,
    output_dir: Path,
    universe: str,
    max_symbols: int,
    symbols: list[str] | None,
    smoke: bool,
) -> Path:
    con = duckdb.connect(str(duckdb_path), read_only=True)
    selected_symbols = discover_symbols(con, universe=universe, max_symbols=max_symbols, symbols=symbols)
    if smoke:
        selected_symbols = selected_symbols[:5]
    if not selected_symbols:
        raise SystemExit("No symbols selected for research")

    raw_5m_symbols = list_raw_5m_symbols()
    coverage: list[CoverageRow] = []
    results_by_family: dict[str, list[dict[str, Any]]] = {}
    raw_holdout_symbols = 0
    daily_gate_frames: dict[str, pd.DataFrame | None] = {}

    intraday_families = {
        "pdh_trap": [{"displacement": 0.005}, {"displacement": 0.0075}, {"displacement": 0.01}],
        "pdl_bounce": [{"displacement": 0.005}, {"displacement": 0.0075}, {"displacement": 0.01}],
        "or_trap": [{"displacement": 0.005}, {"displacement": 0.0075}, {"displacement": 0.01}],
        "or_breakout": [{"displacement": 0.0}],
        "orb_breakout": [{"buffer": 0.001}, {"buffer": 0.003}, {"buffer": 0.005}],
    }

    for symbol in selected_symbols:
        intraday_df = load_frame(con, symbol, "3m")
        daily_df = load_frame(con, symbol, "1d")
        raw_holdout_df = load_raw_5m_frame(symbol)
        daily_gate_frames[symbol] = aggregate_daily_frame(daily_df, symbol)
        raw_holdout_daily = aggregate_daily_frame(raw_holdout_df, symbol)
        if raw_holdout_daily is not None:
            if daily_gate_frames[symbol] is None:
                daily_gate_frames[symbol] = raw_holdout_daily
            else:
                daily_gate_frames[symbol] = (
                    pd.concat([daily_gate_frames[symbol], raw_holdout_daily], ignore_index=True)
                    .sort_values("timestamp")
                    .drop_duplicates(subset=["timestamp"], keep="last")
                    .reset_index(drop=True)
                )
        if raw_holdout_df is not None:
            raw_holdout_symbols += 1

        coverage.append(
            CoverageRow(
                symbol=symbol,
                intraday_timeframe="3m",
                intraday_rows=0 if intraday_df is None else int(len(intraday_df)),
                daily_rows=0 if daily_df is None else int(len(daily_df)),
                intraday_first=None if intraday_df is None else report_dt(intraday_df["timestamp"].min()),
                intraday_last=None if intraday_df is None else report_dt(intraday_df["timestamp"].max()),
                daily_first=None if daily_df is None else report_dt(daily_df["timestamp"].min()),
                daily_last=None if daily_df is None else report_dt(daily_df["timestamp"].max()),
                raw_holdout_5m=symbol in raw_5m_symbols,
            )
        )

        if intraday_df is not None:
            for day, day_df in intraday_df.groupby("session_date", sort=False):
                if pd.Timestamp(day) < STRESS_START:
                    continue
                day_df = day_df.reset_index(drop=True)
                for family, variants in intraday_families.items():
                    for variant in variants:
                        trades = run_intraday_family(day_df, family, variant)
                        trades = [trade for trade in trades if trade is not None]
                        if not trades:
                            continue
                        key = f"{family}:{json.dumps(variant, sort_keys=True)}"
                        results_by_family.setdefault(key, []).extend(trades)

        if raw_holdout_df is not None:
            for day, day_df in raw_holdout_df.groupby("session_date", sort=False):
                if pd.Timestamp(day) < HOLDOUT_START:
                    continue
                day_df = day_df.reset_index(drop=True)
                for family, variants in intraday_families.items():
                    for variant in variants:
                        trades = run_intraday_family(day_df, family, variant)
                        trades = [trade for trade in trades if trade is not None]
                        if not trades:
                            continue
                        key = f"{family}:{json.dumps(variant, sort_keys=True)}:holdout_5m"
                        results_by_family.setdefault(key, []).extend(trades)

        if daily_df is not None:
            for day, day_df in daily_df.groupby("session_date", sort=False):
                if pd.Timestamp(day) < STRESS_START:
                    continue
                day_df = day_df.reset_index(drop=True)
                trades = strategy_chanakya_bullish(day_df)
                trades = [trade for trade in trades if trade is not None]
                if not trades:
                    continue
                key = "chanakya_bullish:{}"
                results_by_family.setdefault(key, []).extend(trades)

    combined_results: dict[str, list[dict[str, Any]]] = {}
    for key, trades in results_by_family.items():
        base_key = key.replace(":holdout_5m", "")
        combined_results.setdefault(base_key, []).extend(trades)

    strategy_results: list[dict[str, Any]] = []
    all_trades: list[dict[str, Any]] = []

    for key, trades in sorted(combined_results.items(), key=lambda item: item[0]):
        family = key.split(":", 1)[0]
        if family == "or_breakout":
            trades = [
                trade
                for trade in trades
                if trade.get("symbol") in OR_BREAKOUT_WHITELIST
                and passes_or_breakout_gate(daily_gate_frames.get(str(trade.get("symbol"))), pd.Timestamp(trade["entry_time"]))
            ]

        split_sets = split_trades(trades)
        split_summaries = {split: summarise_trades(items) for split, items in split_sets.items()}
        recommendation, reason, score = recommendation_for(split_summaries, require_holdout=True)
        yearly = build_yearly_breakdown(trades)
        strategy_results.append(
            {
                "strategy": family,
                "variant": key.split(":", 1)[1] if ":" in key else "",
                "selection_score": round(score, 4),
                "recommendation": recommendation,
                "recommendation_reason": reason,
                "splits": split_summaries,
                "year_by_year": yearly,
                "trade_count": len(trades),
            }
        )
        all_trades.extend(trades)

    strategy_results.sort(
        key=lambda row: (
            row["splits"]["validation"]["net_pnl"],
            row["splits"]["validation"]["profit_factor"] or 0.0,
            row["splits"]["holdout"]["profit_factor"] or 0.0,
            row["splits"]["validation"]["trade_count"],
        ),
        reverse=True,
    )

    report = {
        "configuration": {
            "duckdb_path": str(duckdb_path),
            "universe": universe,
            "max_symbols": max_symbols,
            "smoke": smoke,
            "cost_model": {
                "base_risk_amount": BASE_RISK_AMOUNT,
                "risk_multiplier": DEFAULT_RISK_MULTIPLIER,
                "entry_slippage_pct": ENTRY_SLIPPAGE_PCT,
                "target_exit_slippage_pct": TARGET_EXIT_SLIPPAGE_PCT,
                "stop_exit_slippage_pct": STOP_EXIT_SLIPPAGE_PCT,
                "eod_exit_slippage_pct": EOD_EXIT_SLIPPAGE_PCT,
                "brokerage_per_trade": BROKERAGE_PER_TRADE,
                "statutory_fee_pct": STATUTORY_FEE_PCT,
            },
            "splits": {
                "stress": {"start": STRESS_START.isoformat(), "end": DISCOVERY_START.isoformat()},
                "discovery": {"start": DISCOVERY_START.isoformat(), "end": VALIDATION_START.isoformat()},
                "validation": {"start": VALIDATION_START.isoformat(), "end": HOLDOUT_START.isoformat()},
                "holdout": {"start": HOLDOUT_START.isoformat(), "end": None},
            },
            "data_gap_warning": "2023-2025 are effectively absent in the local intraday warehouse; validation is limited to 2022 for 1d/3m and 2026 holdout is only available on raw 5m files for overlapping symbols.",
            "raw_holdout_symbols": raw_holdout_symbols,
            "selected_symbols": selected_symbols,
            "raw_holdout_symbol_names": sorted(raw_5m_symbols),
        },
        "coverage": [asdict(item) for item in coverage],
        "strategy_results": strategy_results,
        "trades": all_trades,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    out_path = output_dir / f"live-alert-lab-{timestamp}.json"
    out_path.write_text(json.dumps(report, indent=2, sort_keys=True))

    print("\n--- Strategy Ranking ---")
    for row in strategy_results[:12]:
        validation = row["splits"]["validation"]
        holdout = row["splits"]["holdout"]
        print(
            f"{row['strategy']} {row['variant']} | "
            f"validation net={validation['net_pnl']:.2f} pf={validation['profit_factor']} "
            f"holdout net={holdout['net_pnl']:.2f} pf={holdout['profit_factor']} "
            f"=> {row['recommendation']}"
        )

    print(f"\nReport written to {out_path}")
    return out_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Exact live-alert strategy research runner")
    parser.add_argument("--duckdb-path", default=str(DUCKDB_PATH), help="Path to market_store.duckdb")
    parser.add_argument("--output-dir", default=str(REPORT_DIR), help="Directory to write JSON reports")
    parser.add_argument("--universe", default="all", choices=["all", "nifty50"], help="Symbol universe")
    parser.add_argument("--max-symbols", type=int, default=100, help="Maximum symbols to evaluate")
    parser.add_argument("--symbols", default="", help="Optional comma-separated symbol allowlist")
    parser.add_argument("--smoke", action="store_true", help="Run a tiny subset for verification")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    symbols = parse_symbol_list(args.symbols) if args.symbols else None
    run_research(
        duckdb_path=Path(args.duckdb_path),
        output_dir=Path(args.output_dir),
        universe=args.universe,
        max_symbols=args.max_symbols,
        symbols=symbols,
        smoke=args.smoke,
    )


if __name__ == "__main__":
    main()

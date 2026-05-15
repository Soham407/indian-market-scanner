import pandas as pd
import vectorbt as vbt
import glob
import os
import numpy as np
import argparse

NIFTY50_TICKERS = {
    "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK",
    "BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV", "BPCL", "BHARTIARTL",
    "BRITANNIA", "CIPLA", "COALINDIA", "DIVISLAB", "DRREDDY",
    "EICHERMOT", "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE",
    "HEROMOTOCO", "HINDALCO", "HINDUNILVR", "ICICIBANK", "ITC",
    "INDUSINDBK", "INFY", "JSWSTEEL", "KOTAKBANK", "LTIM",
    "LT", "M&M", "MARUTI", "NTPC", "NESTLEIND",
    "ONGC", "POWERGRID", "RELIANCE", "SBILIFE", "SBIN",
    "SUNPHARMA", "TCS", "TATACONSUM", "TATAMOTORS", "TATASTEEL",
    "TECHM", "TITAN", "ULTRACEMCO", "UPL", "WIPRO"
}

def load_ohlcv_files(path_pattern, ticker_filter=None):
    files = glob.glob(path_pattern)
    if not files:
        return None

    processed_dfs = []

    for f in files:
        ticker = os.path.splitext(os.path.basename(f))[0].replace("_5m", "")
        ticker_key = ticker.replace(".NS", "").replace(".BO", "")
        if ticker_filter is not None and ticker_key not in ticker_filter:
            continue
        df = pd.read_csv(f)
        df.columns = [c.strip().lower() for c in df.columns]

        time_col = next((c for c in df.columns if c in ("date", "datetime", "timestamp", "time")), df.columns[0])

        rename_map = {
            "open": "Open",
            "high": "High",
            "low": "Low",
            "close": "Close",
            "volume": "Volume",
        }
        df = df.rename(columns=rename_map)

        required = ["Open", "High", "Low", "Close", "Volume"]
        missing = [col for col in required if col not in df.columns]
        if missing:
            print(f"Skipping {f}: missing columns {missing}")
            continue

        for col in required:
            df[col] = pd.to_numeric(df[col], errors="coerce")

        df = df.dropna(subset=["Close", "High", "Low", "Volume"])
        df[time_col] = pd.to_datetime(df[time_col], utc=True, errors="coerce")
        df = df.dropna(subset=[time_col])
        df.set_index(time_col, inplace=True)
        df.index = df.index.tz_convert("Asia/Kolkata")
        df = df.sort_index()
        df = df[~df.index.duplicated(keep="last")]

        df = df[required]
        df["Symbol"] = ticker
        processed_dfs.append(df)

    if not processed_dfs:
        return None

    master = pd.concat(processed_dfs).sort_index()
    return master


def run_walk_forward_lab(path_pattern="data/raw/intraday/*.csv", ticker_filter=None):
    print("--- Running Verified Walk-Forward Lab ---")

    master = load_ohlcv_files(path_pattern, ticker_filter=ticker_filter)
    if master is None or master.empty:
        print(f"Error: No usable CSV files found for pattern: {path_pattern}")
        return

    c = master.pivot(columns="Symbol", values="Close").ffill()
    h = master.pivot(columns="Symbol", values="High").ffill()
    l = master.pivot(columns="Symbol", values="Low").ffill()
    v = master.pivot(columns="Symbol", values="Volume").fillna(0)

    latest_ts = c.index.max()
    cutoff_ts = latest_ts - pd.Timedelta(days=60)

    if c.index.nunique() < 5:
        print("Error: Need at least 5 unique timestamps for a valid test.")
        return

    print(f"Split Cutoff: {cutoff_ts} | Assets: {len(c.columns)}")

    def build_time_decay_exits(entries, low_s, vwap_s, eod_mask, decay_bars=6):
        exits = pd.DataFrame(False, index=entries.index, columns=entries.columns)

        for col in entries.columns:
            in_position = False
            entry_i = None
            decay_i = None
            entry_idx = entries.index

            entry_arr = entries[col].to_numpy(dtype=bool)
            low_arr = low_s[col].to_numpy(dtype=float)
            vwap_arr = vwap_s[col].to_numpy(dtype=float)
            eod_arr = eod_mask[col].to_numpy(dtype=bool)

            for i in range(len(entry_idx)):
                if not in_position:
                    if entry_arr[i]:
                        in_position = True
                        entry_i = i
                        decay_i = i + decay_bars
                    continue

                if eod_arr[i]:
                    exits.iat[i, exits.columns.get_loc(col)] = True
                    in_position = False
                    entry_i = None
                    decay_i = None
                    continue

                if low_arr[i] <= vwap_arr[i]:
                    exits.iat[i, exits.columns.get_loc(col)] = True
                    in_position = False
                    entry_i = None
                    decay_i = None
                    continue

                if decay_i is not None and i >= decay_i:
                    exits.iat[i, exits.columns.get_loc(col)] = True
                    in_position = False
                    entry_i = None
                    decay_i = None

        return exits

    def run_simulation(c_s, h_s, l_s, v_s):
        tp = (c_s + h_s + l_s) / 3
        tpv = tp * v_s
        vwap = tpv.groupby(tpv.index.date).cumsum() / v_s.groupby(v_s.index.date).cumsum()

        daily_h = h_s.resample('D').max().shift(1).reindex(h_s.index, method='ffill')
        vol_sma = v_s.rolling(window=5).mean().shift(1)
        
        bait = h_s.rolling(window=3).max() > daily_h
        trap = c_s < daily_h
        vol_check = v_s > (vol_sma * 1.5)
        is_above_vwap = c_s > (vwap * 1.002)
        
        hour = c_s.index.hour
        minute = c_s.index.minute
        
        # Strictly between 09:15 and 10:15, as requested.
        is_morning = np.asarray(
            ((hour > 9) | ((hour == 9) & (minute > 15))) &
            ((hour < 10) | ((hour == 10) & (minute < 15)))
        )
        is_eod = np.asarray((hour == 15) & (minute == 15))
        
        # Broadcast to 2D matrices.
        time_mask_2d = pd.DataFrame(np.tile(is_morning[:, None], (1, c_s.shape[1])), index=c_s.index, columns=c_s.columns)
        eod_mask_2d = pd.DataFrame(np.tile(is_eod[:, None], (1, c_s.shape[1])), index=c_s.index, columns=c_s.columns)

        entries = bait & trap & vol_check & time_mask_2d & is_above_vwap
        exits = build_time_decay_exits(entries, l_s, vwap, eod_mask_2d, decay_bars=6)

        return vbt.Portfolio.from_signals(
            c_s, short_entries=entries, short_exits=exits, 
            fees=0.0003, slippage=0.0005, sl_stop=0.01, freq='5min'
        )

    is_mask = c.index < cutoff_ts
    oos_mask = c.index >= cutoff_ts

    print("\n--- [ IN-SAMPLE (Training) ] ---")
    pf_is = run_simulation(c[is_mask], h[is_mask], l[is_mask], v[is_mask])
    print(f"Trades: {pf_is.trades.count().sum()} | Avg Expectancy: {pf_is.trades.expectancy().mean():.2f}")

    print("\n--- [ OUT-OF-SAMPLE (Validation) ] ---")
    pf_oos = run_simulation(c[oos_mask], h[oos_mask], l[oos_mask], v[oos_mask])
    print(f"Trades: {pf_oos.trades.count().sum()} | Avg Expectancy: {pf_oos.trades.expectancy().mean():.2f}")
    print(f"OOS Win Rate: {pf_oos.trades.win_rate().mean()*100:.2f}%")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data-dir",
        default="data/raw/intraday",
        help="Directory, glob pattern, or single CSV containing 5-minute data",
    )
    parser.add_argument(
        "--universe",
        default="nifty50",
        choices=["nifty50", "all"],
        help="Ticker universe to trade",
    )
    args = parser.parse_args()
    if any(ch in args.data_dir for ch in "*?[]"):
        pattern = args.data_dir
    elif os.path.isdir(args.data_dir):
        pattern = os.path.join(args.data_dir, "*.csv")
    else:
        pattern = args.data_dir
    ticker_filter = NIFTY50_TICKERS if args.universe == "nifty50" else None
    run_walk_forward_lab(pattern, ticker_filter=ticker_filter)

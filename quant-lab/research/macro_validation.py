import yfinance as yf
import vectorbt as vbt
import pandas as pd
import os

def run_3yr_macro_check():
    print("--- Running 3-Year Structural Check (Daily Data) ---")
    
    tickers = [
        "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "ICICIBANK.NS", "INFY.NS",
        "AXISBANK.NS", "SBIN.NS", "BHARTIARTL.NS", "ITC.NS", "LT.NS"
    ]
    
    # 1. Download 3 Years of Daily Data
    data = yf.download(tickers, period="3y", interval="1d", progress=False)
    
    close = data['Close']
    open_p = data['Open']
    high = data['High']
    prev_high = high.shift(1)

    # 2. Strategy: Gap Up Above Prev Day High, but Close below Open/Prev High
    # This identifies "Failed Breakouts" on a daily timeframe
    is_gap_up = open_p > prev_high
    is_reversal = (close < open_p) & (close < prev_high)
    
    short_entries = is_gap_up & is_reversal
    
    # Exit at the end of the same day
    short_exits = pd.DataFrame(True, index=short_entries.index, columns=short_entries.columns)

    # 3. Portfolio Simulation
    pf = vbt.Portfolio.from_signals(
        close,
        short_entries=short_entries,
        short_exits=short_exits,
        init_cash=100000,
        fees=0.0003, # 0.03%
        slippage=0.0005 # 0.05%
    )

    print("\n[ 3-Year Macro Result ]")
    print(pf.stats())
    
    # Check if the expectancy is positive
    expectancy = pf.trades.expectancy().mean()
    if expectancy > 0:
        print(f"\nVALIDATED: The Gap-Up Reversal has a structural expectancy of ₹{expectancy:.2f}")
    else:
        print("\nWARNING: No structural edge found on Daily timeframe.")

if __name__ == "__main__":
    run_3yr_macro_check()
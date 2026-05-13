import yfinance as yf
import pandas as pd
import os
import time

def update_free_database():
    # The Full Nifty 50 Universe
    nifty50_tickers = [
        "ADANIENT.NS", "ADANIPORTS.NS", "APOLLOHOSP.NS", "ASIANPAINT.NS", "AXISBANK.NS",
        "BAJAJ-AUTO.NS", "BAJFINANCE.NS", "BAJAJFINSV.NS", "BPCL.NS", "BHARTIARTL.NS",
        "BRITANNIA.NS", "CIPLA.NS", "COALINDIA.NS", "DIVISLAB.NS", "DRREDDY.NS",
        "EICHERMOT.NS", "GRASIM.NS", "HCLTECH.NS", "HDFCBANK.NS", "HDFCLIFE.NS",
        "HEROMOTOCO.NS", "HINDALCO.NS", "HINDUNILVR.NS", "ICICIBANK.NS", "ITC.NS",
        "INDUSINDBK.NS", "INFY.NS", "JSWSTEEL.NS", "KOTAKBANK.NS", "LTIM.NS",
        "LT.NS", "M&M.NS", "MARUTI.NS", "NTPC.NS", "NESTLEIND.NS",
        "ONGC.NS", "POWERGRID.NS", "RELIANCE.NS", "SBILIFE.NS", "SBIN.NS",
        "SUNPHARMA.NS", "TCS.NS", "TATACONSUM.NS", "TATAMOTORS.NS", "TATASTEEL.NS",
        "TECHM.NS", "TITAN.NS", "ULTRACEMCO.NS", "UPL.NS", "WIPRO.NS"
    ]

    os.makedirs('data/raw/intraday', exist_ok=True)
    print(f"--- Initiating Nifty 50 Mass Sync ({len(nifty50_tickers)} Assets) ---")
    
    success_count = 0

    for ticker in nifty50_tickers:
        print(f"Syncing {ticker}...")
        try:
            # Fetch max 60 days of 5m data
            df = yf.download(ticker, period="60d", interval="5m", progress=False)
            
            if df.empty:
                print(f"  -> No data found for {ticker}. Skipping.")
                continue
            
            # Flatten columns if yfinance returns a MultiIndex
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.droplevel(1)

            path = f"data/raw/intraday/{ticker}_5m.csv"
            
            if os.path.exists(path):
                # Merge and drop duplicates to grow the DB over time
                old_df = pd.read_csv(path, index_col=0, parse_dates=True)
                df = pd.concat([old_df, df]).drop_duplicates().sort_index()
            
            df.to_csv(path)
            success_count += 1
            
        except Exception as e:
            print(f"  -> Error syncing {ticker}: {e}")
        
        # 0.5s throttle to prevent Yahoo Finance from IP-banning us for spamming requests
        time.sleep(0.5)

    print(f"\n--- Sync Complete: {success_count}/{len(nifty50_tickers)} Assets Updated ---")

if __name__ == "__main__":
    update_free_database()
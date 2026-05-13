import yfinance as yf
import pandas as pd
import pandas_ta as ta
import os

def fetch_nifty_50_matrix(days=60):
    """
    Downloads and processes the entire Nifty 50 universe into 
    VectorBT-ready 2D DataFrames.
    """
    # 1. Official Nifty 50 Ticker List
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

    print(f"--- Scaled Ingestion: Fetching {len(nifty50_tickers)} Tickers ---")
    
    # 2. Batch Download (Optimized for Network I/O)
    raw_data = yf.download(nifty50_tickers, period=f"{days}d", interval="5m", group_by='ticker', progress=True)
    
    # 3. Clean and Structural Alignment
    processed_list = []
    
    for ticker in nifty50_tickers:
        try:
            # Extract single ticker slice from MultiIndex
            df = raw_data[ticker].copy().dropna()
            if df.empty: continue
            
            # Timezone Alignment
            df.index = df.index.tz_convert('Asia/Kolkata')
            
            # Feature Engineering: PDH
            daily_highs = df['High'].resample('D').max().dropna()
            df['PDH'] = df.index.map(
                lambda x: daily_highs.shift(1).get(pd.Timestamp(x.date()).tz_localize(daily_highs.index.tz))
            )
            df['PDH'] = df['PDH'].ffill()

            # Feature Engineering: VWAP
            df.ta.vwap(append=True)
            
            # Feature Engineering: Volume SMA
            df['Vol_SMA_5'] = df['Volume'].shift(1).rolling(window=5).mean()
            
            # Add Ticker column for identification before stacking
            df['Symbol'] = ticker
            processed_list.append(df)
            
        except Exception as e:
            print(f"Skipping {ticker}: {e}")

    # 4. Final Aggregation
    final_df = pd.concat(processed_list)
    
    # Save as a single master Parquet for the Lab
    os.makedirs("data/processed", exist_ok=True)
    save_path = "data/processed/nifty50_master.parquet"
    final_df.to_parquet(save_path)
    
    print(f"\n--- Success: {len(processed_list)} Assets Saved to {save_path} ---")
    return final_df

if __name__ == "__main__":
    fetch_nifty_50_matrix(days=60)
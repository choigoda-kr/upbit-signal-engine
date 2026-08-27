import pyupbit
import time
import pandas as pd
import numpy as np
from config import TARGET_TICKERS
import db_manager
import sqlite3

def fetch_all_tickers():
    print("[백엔드] 데이터 수집 및 전략 백테스트 지표 일괄 계산 시작!")
    
    db_manager.init_db()
    
    # 1. 가격 데이터 수집 및 기본 MA 계산
    for ticker in TARGET_TICKERS:
        print(f"[수집 중] {ticker} 데이터 갱신...")
        df_list = []
        to_date = None
        for i in range(4):
            df = pyupbit.get_ohlcv(ticker, interval="day", count=200, to=to_date)
            if df is None or df.empty:
                break
            df_list.append(df)
            to_date = df.index[0]
            time.sleep(0.1)
            
        if df_list:
            merged_df = pd.concat(df_list)
            merged_df = merged_df[~merged_df.index.duplicated(keep='first')]
            merged_df.sort_index(inplace=True)
            
            price_df = merged_df[['close']].copy()
            price_df.rename(columns={'close': 'price'}, inplace=True)
            price_df['ma3'] = price_df['price'].rolling(window=3).mean()
            price_df['ma6'] = price_df['price'].rolling(window=6).mean()
            price_df['ma12'] = price_df['price'].rolling(window=12).mean()
            price_df['ma120'] = price_df['price'].rolling(window=120).mean()
            
            db_manager.save_daily_prices(price_df, ticker)
        else:
            print(f"[수집 실패] {ticker}")

    # 2. 모든 데이터를 DB에서 다시 읽어와 포트폴리오 산출
    print("[백엔드] 모멘텀 지표 및 포트폴리오 결과 산출 중...")
    query = f"SELECT ticker, date, price, ma3, ma12, ma120 FROM daily_price_data WHERE ticker IN ({','.join(['?']*len(TARGET_TICKERS))})"
    df = db_manager.read_query(query, params=TARGET_TICKERS)
    
    df['date'] = pd.to_datetime(df['date'])
    
    price_df = df.pivot(index='date', columns='ticker', values='price').sort_index()
    ma3_df = df.pivot(index='date', columns='ticker', values='ma3').sort_index()
    ma12_df = df.pivot(index='date', columns='ticker', values='ma12').sort_index()
    ma120_df = df.pivot(index='date', columns='ticker', values='ma120').sort_index()
    
    mom1 = price_df.pct_change(1).round(4)
    mom_ma = ma3_df.pct_change(1).round(4)
    daily_returns = price_df.pct_change(1).shift(-1)
    
    dates = price_df.index
    tickers = price_df.columns
    
    momentum_logs = []
    portfolio_logs = []
    strategy_reports = []
    
    prev_holdings = {t: 0.0 for t in tickers}
    fee_rate = 0.0015 # 0.15%
    
    for i in range(120, len(dates)):
        date = dates[i]
        date_str = date.strftime('%Y-%m-%d %H:%M:%S')
        
        btc_price = price_df.loc[date, 'KRW-BTC']
        btc_ma_long = ma120_df.loc[date, 'KRW-BTC']
        
        target_weights = {t: 0.0 for t in tickers}
        
        # 유효 코인 필터링
        valid_coins = []
        is_valid_dict = {t: 0 for t in tickers}
        
        for t in tickers:
            p = price_df.loc[date, t]
            m3 = ma3_df.loc[date, t]
            m12 = ma12_df.loc[date, t]
            if pd.notna(p) and pd.notna(m3) and pd.notna(m12):
                if m3 >= m12:
                    valid_coins.append(t)
                    is_valid_dict[t] = 1
                    
        # 모멘텀 기록 생성
        for t in tickers:
            m1 = mom1.loc[date, t]
            mm3 = mom_ma.loc[date, t]
            if pd.notna(m1):
                momentum_logs.append((date_str, t, p, m3, m12, is_valid_dict[t], m1, mm3))
            
        # 마켓 타이밍 필터
        if pd.isna(btc_price) or pd.isna(btc_ma_long) or btc_price < btc_ma_long:
            pass # 100% 현금
        else:
            if len(valid_coins) > 0:
                weight_total = len(valid_coins) / len(tickers)
                mom1_valid = mom1.loc[date, valid_coins]
                mom_ma_valid = mom_ma.loc[date, valid_coins]
                
                # 기본 전략: 1위 겹칠 때 3일 이평 변동률 2순위 선택
                coin_a = mom1_valid.idxmax()
                coin_b = mom_ma_valid.idxmax()
                
                if coin_a == coin_b and len(valid_coins) > 1:
                    m3_temp = mom_ma_valid.drop(coin_b)
                    coin_b = m3_temp.idxmax()
                
                if len(valid_coins) == 1:
                    target_weights[coin_a] = weight_total
                else:
                    target_weights[coin_a] += weight_total * 0.5
                    target_weights[coin_b] += weight_total * 0.5
                    
        bought_coins = [f"{t}({target_weights[t]*100:.1f}%)" for t in TARGET_TICKERS if target_weights[t] > 0]
        coins_str = ", ".join(bought_coins) if bought_coins else "현금 100% 관망"
        
        # 포트폴리오 적용 날짜 (내일)
        if i < len(dates) - 1:
            apply_date = dates[i+1].strftime('%Y-%m-%d %H:%M:%S')
            
            turnover = sum(abs(target_weights[t] - prev_holdings[t]) for t in tickers)
            fee_cost = turnover * fee_rate
            gross_ret = sum(target_weights[t] * daily_returns.loc[date, t] for t in tickers if pd.notna(daily_returns.loc[date, t]))
            net_ret = gross_ret - fee_cost
            
            portfolio_logs.append((apply_date, coins_str, net_ret * 100))
            
            prev_holdings = target_weights
        else:
            # 마지막 날(오늘) -> 내일 예상
            apply_date = (dates[i] + pd.Timedelta(days=1)).strftime('%Y-%m-%d %H:%M:%S')
            portfolio_logs.append((apply_date, coins_str, 0.0))
            
        # Strategy Report 생성 (테이블 C) - 적용일(apply_date) 기준으로 기록하여 포트폴리오와 맞춤
        report_row = [apply_date]
        m1_dict = mom1.loc[date, tickers].to_dict()
        mm3_dict = mom_ma.loc[date, tickers].to_dict()
        
        for t in TARGET_TICKERS:
            report_row.append(m1_dict.get(t, np.nan))
            report_row.append(mm3_dict.get(t, np.nan))
            
        # 순위 도출 (전체 종목 대상 단순 변동률 순위)
        m1_sorted = pd.Series(m1_dict).dropna().sort_values(ascending=False)
        mm3_sorted = pd.Series(mm3_dict).dropna().sort_values(ascending=False)
        
        def get_rank(series, rank):
            return series.index[rank-1] if len(series) >= rank else None
            
        report_row.extend([
            get_rank(m1_sorted, 1), get_rank(m1_sorted, 2), get_rank(m1_sorted, 3),
            get_rank(mm3_sorted, 1), get_rank(mm3_sorted, 2), get_rank(mm3_sorted, 3),
            coins_str
        ])
        strategy_reports.append(report_row)
        
    # DB 덮어쓰기 (Upsert / Delete-Insert)
    conn = db_manager.get_connection()
    c = conn.cursor()
    c.execute("DELETE FROM daily_momentum_log")
    c.execute("DELETE FROM daily_portfolio_log")
    c.execute("DELETE FROM strategy_report")
    
    c.executemany("INSERT INTO daily_momentum_log VALUES (?,?,?,?,?,?,?,?)", momentum_logs)
    c.executemany("INSERT INTO daily_portfolio_log VALUES (?,?,?)", portfolio_logs)
    
    cols = ["?" for _ in range(1 + len(TARGET_TICKERS)*2 + 7)]
    c.executemany(f"INSERT INTO strategy_report VALUES ({','.join(cols)})", strategy_reports)
    
    conn.commit()
    conn.close()
    
    print("[백엔드] 모든 데이터 적재 완료!")

if __name__ == "__main__":
    fetch_all_tickers()

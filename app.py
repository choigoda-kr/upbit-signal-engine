import streamlit as st
import pandas as pd
import numpy as np
import sqlite3
import pyupbit
import os
from datetime import datetime
import pytz
try:
    from streamlit_autorefresh import st_autorefresh
except:
    st_autorefresh = None

from config import TARGET_TICKERS
import db_manager

st.set_page_config(page_title="업비트 퀀트 시뮬레이터", layout="wide")

# 애플 테마 스타일 주입
st.markdown("""
    <style>
    .stApp {
        background-color: #F5F5F7;
        font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    }
    .apple-card {
        background-color: #FFFFFF;
        border-radius: 18px;
        padding: 24px;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.04), 0 1px 3px rgba(0, 0, 0, 0.08);
        margin-bottom: 24px;
        color: #1D1D1F;
    }
    .apple-title {
        font-size: 24px;
        font-weight: 600;
        margin-bottom: 8px;
        color: #1D1D1F;
    }
    .apple-metric-label {
        font-size: 14px;
        color: #86868B;
        font-weight: 500;
        margin-bottom: 4px;
    }
    .apple-metric-value {
        font-size: 32px;
        font-weight: 700;
        color: #1D1D1F;
    }
    .portfolio-text {
        font-size: 20px;
        font-weight: 500;
        color: #007AFF;
        margin-top: 10px;
    }
    .apple-card table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 16px;
    }
    .apple-card th, .apple-card td {
        padding: 12px;
        text-align: left;
        border-bottom: 1px solid #E5E5EA;
    }
    .apple-card th {
        color: #86868B;
        font-weight: 500;
        font-size: 14px;
    }
    </style>
""", unsafe_allow_html=True)

if st_autorefresh:
    # 1분(60000ms)마다 자동 새로고침
    st_autorefresh(interval=60000, limit=1000, key="data_refresh")

def get_live_prediction():
    # 1. DB에서 최근 150일치 가격 데이터 조회
    conn = db_manager.get_connection()
    query = f"SELECT ticker, date, price FROM daily_price_data WHERE ticker IN ({','.join(['?']*len(TARGET_TICKERS))})"
    df = pd.read_sql(query, conn, params=TARGET_TICKERS)
    conn.close()
    
    if df.empty:
        return "데이터 없음 (백엔드 실행 필요)"
        
    df['date'] = pd.to_datetime(df['date'])
    price_df = df.pivot(index='date', columns='ticker', values='price').sort_index().tail(150)
    
    # 2. 현재 실시간 가격 가져오기
    current_prices = pyupbit.get_current_price(TARGET_TICKERS)
    
    # 3. 데이터프레임에 오늘(Live) 행 추가
    kst = pytz.timezone('Asia/Seoul')
    now = datetime.now(kst)
    if now.hour < 9:
        today_date = (now - pd.Timedelta(days=1)).strftime('%Y-%m-%d 09:00:00')
    else:
        today_date = now.strftime('%Y-%m-%d 09:00:00')
        
    today_dt = pd.to_datetime(today_date)
    
    if current_prices:
        for t in TARGET_TICKERS:
            if t in current_prices:
                price_df.loc[today_dt, t] = current_prices[t]
            
    # MA 및 모멘텀 계산
    ma3_df = price_df.rolling(3).mean()
    ma12_df = price_df.rolling(12).mean()
    ma120_df = price_df.rolling(120).mean()
    
    mom1 = price_df.pct_change(1)
    mom_ma3 = ma3_df.pct_change(1)
    
    # 오늘 자 데이터 추출
    date = today_dt
    if date not in price_df.index:
        return "데이터 로딩 대기 중..."
        
    btc_price = price_df.loc[date, 'KRW-BTC']
    btc_ma_long = ma120_df.loc[date, 'KRW-BTC']
    
    target_weights = {t: 0.0 for t in TARGET_TICKERS}
    
    if pd.isna(btc_price) or pd.isna(btc_ma_long) or btc_price < btc_ma_long:
        return "현금 100% 관망"
        
    valid_coins = []
    for t in TARGET_TICKERS:
        p = price_df.loc[date, t]
        m3 = ma3_df.loc[date, t]
        m12 = ma12_df.loc[date, t]
        if pd.notna(p) and pd.notna(m3) and pd.notna(m12):
            if m3 >= m12:
                valid_coins.append(t)
                
    if len(valid_coins) > 0:
        weight_total = len(valid_coins) / len(TARGET_TICKERS)
        mom1_valid = mom1.loc[date, valid_coins]
        mom_ma_valid = mom_ma3.loc[date, valid_coins]
        
        coin_a = mom1_valid.idxmax()
        coin_b = mom_ma_valid.idxmax()
        
        if coin_a == coin_b and len(valid_coins) > 1:
            mom1_valid = mom1_valid.drop(coin_a)
            coin_a = mom1_valid.idxmax()
            
        if len(valid_coins) == 1:
            target_weights[coin_a] = weight_total
        else:
            target_weights[coin_a] += weight_total * 0.5
            target_weights[coin_b] += weight_total * 0.5
            
    bought_coins = [f"{t}({target_weights[t]*100:.1f}%)" for t in TARGET_TICKERS if target_weights[t] > 0]
    return ", ".join(bought_coins) if bought_coins else "현금 100% 관망"

def get_today_fixed_portfolio():
    conn = db_manager.get_connection()
    try:
        kst = pytz.timezone('Asia/Seoul')
        now = datetime.now(kst)
        if now.hour < 9:
            today_date = (now - pd.Timedelta(days=1)).strftime('%Y-%m-%d 09:00:00')
        else:
            today_date = now.strftime('%Y-%m-%d 09:00:00')
            
        query = f"SELECT recommended_portfolio FROM daily_portfolio_log WHERE date <= '{today_date}' ORDER BY date DESC LIMIT 1"
        df = pd.read_sql(query, conn)
        if not df.empty:
            return df.iloc[0]['recommended_portfolio']
    except Exception as e:
        pass
    finally:
        conn.close()
    return "데이터 없음"

def get_annual_returns():
    conn = db_manager.get_connection()
    try:
        kst = pytz.timezone('Asia/Seoul')
        now = datetime.now(kst)
        if now.hour < 9:
            today_date = (now - pd.Timedelta(days=1)).strftime('%Y-%m-%d 09:00:00')
        else:
            today_date = now.strftime('%Y-%m-%d 09:00:00')
            
        query = f"SELECT date, actual_return FROM daily_portfolio_log WHERE date <= '{today_date}' ORDER BY date ASC"
        df = pd.read_sql(query, conn)
        
        if df.empty:
            return None
            
        df['date'] = pd.to_datetime(df['date'])
        
        def calc_annual(df, col):
            df['net'] = df[col] / 100.0
            results = {}
            for year in [2024, 2025, 2026]:
                ydf = df[df['date'].dt.year == year]
                if not ydf.empty:
                    ret = (1 + ydf['net']).prod() - 1
                    results[f"{year}년"] = f"{ret*100:.2f}%"
                else:
                    results[f"{year}년"] = "-"
            return results
            
        ret_A = calc_annual(df.copy(), 'actual_return')
        
        return pd.DataFrame([ret_A])
        
    except Exception as e:
        pass
    finally:
        conn.close()
    return None

today_fixed = get_today_fixed_portfolio().replace('KRW-', '')
tomorrow_live = get_live_prediction().replace('KRW-', '')

col1, col2 = st.columns(2)

with col1:
    st.markdown(f"""
        <div class="apple-card">
            <div class="apple-title">오늘 확정 매수</div>
            <div class="apple-metric-label">Today's Fixed Target</div>
            <div class="portfolio-text">{today_fixed}</div>
        </div>
    """, unsafe_allow_html=True)

with col2:
    kst = pytz.timezone('Asia/Seoul')
    now = datetime.now(kst).strftime("%H:%M:%S")
    st.markdown(f"""
        <div class="apple-card">
            <div class="apple-title">내일 예상 매수 <span style="color:#FF3B30; font-size:16px;">(Live - {now})</span></div>
            <div class="apple-metric-label">Tomorrow's Expected Target</div>
            <div class="portfolio-text">{tomorrow_live}</div>
        </div>
    """, unsafe_allow_html=True)

df_a = get_annual_returns()

if df_a is not None:
    html_table = df_a.to_html(classes="table", index=False, border=0)
    st.markdown(f"""
        <div class="apple-card">
            <div class="apple-title">연도별 수익률</div>
            <div class="apple-metric-label">Annual Returns</div>
            {html_table}
        </div>
    """, unsafe_allow_html=True)

import sqlite3
import pandas as pd
import numpy as np
import os
from config import TARGET_TICKERS

# 클라우드 런(GCS 마운트) 환경이면 마운트 경로, 아니면 로컬 경로 사용
DB_FILE = "/mnt/db/upbit_market_data.db" if os.path.exists("/mnt/db") else "upbit_market_data.db"

def get_connection():
    return sqlite3.connect(DB_FILE)

def init_db():
    conn = get_connection()
    cursor = conn.cursor()
    
    # 1. daily_price_data
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS daily_price_data (
            ticker TEXT,
            date TEXT,
            price REAL,
            ma3 REAL,
            ma6 REAL,
            ma12 REAL,
            ma120 REAL,
            PRIMARY KEY (ticker, date)
        )
    ''')
    
    # 2. daily_momentum_log (테이블 A)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS daily_momentum_log (
            date TEXT,
            ticker TEXT,
            price REAL,
            ma3 REAL,
            ma12 REAL,
            is_valid INTEGER,
            mom1 REAL,
            mom_ma3 REAL,
            PRIMARY KEY (date, ticker)
        )
    ''')
    
    # 3. daily_portfolio_log (테이블 B)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS daily_portfolio_log (
            date TEXT PRIMARY KEY,
            recommended_portfolio TEXT,
            actual_return REAL
        )
    ''')
    
    # 4. strategy_report (테이블 C)
    # 동적 쿼리로 컬럼 생성 (11개 종목에 대해 전일변동, 3일변동)
    columns = ["date TEXT PRIMARY KEY"]
    for t in TARGET_TICKERS:
        t_name = t.split('-')[1]
        columns.append(f'"전일변동_{t_name}" REAL')
        columns.append(f'"3일변동_{t_name}" REAL')
    
    columns.extend([
        '"전일변동_1순위" TEXT', '"전일변동_2순위" TEXT', '"전일변동_3순위" TEXT',
        '"3일변동_1순위" TEXT', '"3일변동_2순위" TEXT', '"3일변동_3순위" TEXT',
        '"최종매수종목" TEXT'
    ])
    
    cursor.execute(f'''
        CREATE TABLE IF NOT EXISTS strategy_report (
            {', '.join(columns)}
        )
    ''')

    
    conn.commit()
    conn.close()

def save_daily_prices(df, ticker):
    if df.empty:
        return
    conn = get_connection()
    cursor = conn.cursor()
    df = df.reset_index()
    if 'index' in df.columns:
        df.rename(columns={'index': 'date'}, inplace=True)
    df['date'] = df['date'].astype(str)
    df['ticker'] = ticker
    df = df.replace({np.nan: None})
    records = df[['ticker', 'date', 'price', 'ma3', 'ma6', 'ma12', 'ma120']].values.tolist()
    cursor.executemany('''
        INSERT OR REPLACE INTO daily_price_data (ticker, date, price, ma3, ma6, ma12, ma120)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', records)
    conn.commit()
    conn.close()

def save_dataframe_to_db(df, table_name, index_label=None):
    if df.empty: return
    conn = get_connection()
    df.to_sql(table_name, conn, if_exists='append', index=index_label is not None, index_label=index_label)
    conn.close()

def execute_query(query, params=()):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(query, params)
    conn.commit()
    conn.close()

def read_query(query, params=()):
    conn = get_connection()
    df = pd.read_sql(query, conn, params=params)
    conn.close()
    return df

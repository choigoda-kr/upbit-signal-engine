import sqlite3
import pandas as pd
import numpy as np
import os
from config import TARGET_TICKERS

# ─── GCS 설정 ────────────────────────────────────────────────
GCS_BUCKET = "upbit-signal-engine-db-bucket"  # GCS 버킷 이름
GCS_BLOB   = "upbit_market_data.db"        # GCS 내 파일 이름
LOCAL_DB   = "upbit_market_data.db"        # 로컬 실행 경로
CLOUD_DB   = "/tmp/upbit_market_data.db"   # 클라우드 임시 경로
# ─────────────────────────────────────────────────────────────

def _get_gcs_client():
    """GCS 클라이언트 생성 (Streamlit Secrets 또는 로컬 자격증명 자동 감지)"""
    from google.cloud import storage
    try:
        import streamlit as st
        from google.oauth2 import service_account
        creds_info = dict(st.secrets["gcs_service_account"])
        credentials = service_account.Credentials.from_service_account_info(creds_info)
        return storage.Client(credentials=credentials)
    except Exception:
        # 로컬 환경: GOOGLE_APPLICATION_CREDENTIALS 또는 gcs_credentials.json 사용
        cred_file = "gcs_credentials.json"
        if os.path.exists(cred_file):
            from google.oauth2 import service_account
            credentials = service_account.Credentials.from_service_account_file(cred_file)
            return storage.Client(credentials=credentials)
        return storage.Client()

def _download_db_from_gcs():
    """GCS에서 .db 파일을 /tmp 경로로 다운로드"""
    print("[GCS] DB 파일 다운로드 중...")
    client = _get_gcs_client()
    bucket = client.bucket(GCS_BUCKET)
    blob = bucket.blob(GCS_BLOB)
    blob.download_to_filename(CLOUD_DB)
    print(f"[GCS] 다운로드 완료 → {CLOUD_DB}")

def _get_db_file():
    """실행 환경에 맞는 DB 경로 자동 반환"""
    # 1. 로컬 DB 파일이 있으면 그대로 사용
    if os.path.exists(LOCAL_DB):
        return LOCAL_DB
    # 2. 클라우드 임시 경로에 이미 다운로드된 경우
    if os.path.exists(CLOUD_DB):
        return CLOUD_DB
    # 3. 클라우드 환경: GCS에서 다운로드
    _download_db_from_gcs()
    return CLOUD_DB

DB_FILE = _get_db_file()

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

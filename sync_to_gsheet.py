import gspread
import google.auth
import os
import pandas as pd
import sqlite3
import db_manager
from google.oauth2.service_account import Credentials

SHEET_URL = 'https://docs.google.com/spreadsheets/d/1KM-aospMwSM6C5g6xL_AkoMO545jyeJtCSNPrYyr8NM'

def sync_data():
    print("[Sync] 구글 시트 동기화 시작...")
    
    # 1. DB에서 strategy_report 읽어오기
    conn = db_manager.get_connection()
    df = pd.read_sql("SELECT * FROM strategy_report ORDER BY date ASC", conn)
    conn.close()
    
    if df.empty:
        print("[Sync] DB에 데이터가 없습니다.")
        return

    # 컬럼명을 문자열로 변환 (구글 시트 헤더용)
    df.columns = [str(c) for c in df.columns]
    
    # 2. 구글 인증 (서비스 계정 JSON이 있으면 사용, 없으면 Cloud Run 기본 인증 사용)
    try:
        if os.path.exists('credentials.json'):
            print("[Sync] 로컬 credentials.json 파일을 사용하여 인증합니다.")
            creds = Credentials.from_service_account_file('credentials.json', scopes=[
                'https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/drive'
            ])
            gc = gspread.authorize(creds)
        else:
            print("[Sync] Cloud Run 기본 인증(Application Default Credentials)을 시도합니다.")
            credentials, project = google.auth.default(scopes=[
                'https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/drive'
            ])
            gc = gspread.authorize(credentials)
            
        # 3. 구글 시트 접근
        sh = gc.open_by_url(SHEET_URL)
        worksheet = sh.worksheet('일별데이터')
        
        # 4. 데이터 쓰기 (기존 데이터 지우고 새로 쓰기)
        # 구글 시트 할당량을 줄이기 위해 한 번에 덮어씁니다.
        worksheet.clear()
        
        # DataFrame을 리스트의 리스트로 변환
        data_to_write = [df.columns.values.tolist()] + df.fillna("").values.tolist()
        worksheet.update('A1', data_to_write)
        
        print(f"[Sync] 성공적으로 동기화되었습니다. (총 {len(df)}행)")
        
    except Exception as e:
        print(f"[Sync] 구글 시트 동기화 실패: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    sync_data()

import pandas as pd
import db_manager
from datetime import datetime

def export_data():
    print("[엑셀 추출 모드] DB 금고에서 데이터를 꺼내옵니다...")
    conn = db_manager.get_connection()
    
    try:
        # 전체 데이터 읽어오기 (날짜 최신순 정렬)
        query = "SELECT * FROM daily_candles ORDER BY date DESC"
        df = pd.read_sql(query, conn)
        
        if df.empty:
            print("[안내] DB가 텅 비었습니다! 먼저 수집 스크립트(fetch)를 실행해 주세요.")
            return

        # 오늘 날짜를 활용하여 엑셀 파일명 생성
        today_str = datetime.now().strftime("%Y%m%d_%H%M")
        filename = f"upbit_market_data_{today_str}.xlsx"
        
        # 엑셀로 깔끔하게 저장 (index 제외)
        df.to_excel(filename, index=False)
        print(f"[추출 대성공] {len(df)}건의 데이터가 '{filename}' 파일로 예쁘게 포장되었습니다!")
        print("이제 엑셀을 열고 VLOOKUP, INDEX 등 대표님의 장기인 함수들을 마음껏 뽐내며 기획해 보세요!")
        
    except Exception as e:
        print(f"[에러 발생] 문제가 생겼습니다: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    export_data()

FROM python:3.10-slim

WORKDIR /app

# 시스템 의존성 설치 (필요시)
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 현재 폴더의 모든 파일(데이터베이스 포함)을 컨테이너 안으로 복사
COPY . .

# 구글 Cloud Run은 $PORT 환경 변수를 사용합니다. (기본값 8080)
EXPOSE 8080

# Streamlit 앱 실행 명령어
CMD ["streamlit", "run", "app.py", "--server.port=8080", "--server.address=0.0.0.0"]

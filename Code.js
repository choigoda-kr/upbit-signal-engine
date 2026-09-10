/**
 * ============================================================
 *  업비트 8종 시세 DB  →  구글시트 '일별시세'
 * ------------------------------------------------------------
 *  · 일별 종가(확정) + 현재가(5분 갱신)를 한 시트에 누적
 *  · 정렬 : 과거 → 최신 (오름차순), 현재가는 항상 맨 아래 행
 *  · 원칙 : 확정된 과거 행은 절대 재갱신하지 않음 (불변)
 *  · 업비트 날짜 기준 : 매일 오전 9시(KST)에 날짜가 바뀜
 * ============================================================
 *
 *  [실행 함수 안내]
 *   1) initialLoad()    : 최초 1회 수동 실행 - START_DATE부터 전량 적재
 *   2) setupTriggers()  : 최초 1회 수동 실행 - 자동 트리거 2종 설치
 *   3) updateCurrent()  : 5분마다 자동 - 맨 아래 현재가 행만 갱신
 *   4) finalizeDaily()  : 매일 09:01 자동 - 전일 종가 확정 + 새 행 생성
 */

// -- 설정 ----------------------------------------------------
var SHEET_ID   = '1-j8nbB1PGP2HIOqZmKQUVJU-CpupABlQyc4nBqfzGYg';
var SHEET_NAME = '일별시세';
var COINS      = ['BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'LINK', 'VIRTUAL', 'XLM'];
var START_DATE = '2019-09-03';
var TZ         = 'Asia/Seoul';

var COL_DATE   = 1;                       // A열 : 날짜
var COL_FIRST  = 2;                       // B열 : 첫 종목 가격
var COL_STAMP  = 2 + COINS.length * 2;    // R열 : 갱신시각
var TOTAL_COLS = COL_STAMP;               // 총 18열 (A~R)

var FMT_PRICE  = '#,##0';
var FMT_RATE   = '[Red]+#,##0.00%;[Blue]-#,##0.00%;#,##0.00%';

// -- 이동평균 설정 -------------------------------------------
var MA_SHEET     = '이동평균';
var MA_PERIODS   = [3, 6, 12, 60, 120];                       // 기간별 묶음 순서
var MA_COL_FIRST = 2;                                          // B열 : MA3_BTC
var MA_STAMP_COL = 2 + MA_PERIODS.length * COINS.length;       // AP열 : 갱신시각
var MA_TOTAL     = MA_STAMP_COL;                               // 총 42열 (A~AP)
var FMT_MA       = '#,##0.00';                                 // 셋째 자리 반올림 표시

// -- 변동률 / 이격도 설정 ------------------------------------
var CR_SHEET     = '변동률';                                    // 이동평균선 자체의 전일 대비 변화율
var DV_SHEET     = '이격도';                                    // 가격과 이동평균 간 괴리율
var CR_PERIODS   = [3, 6, 12, 60];                             // MA120 제외
var CR_COL_FIRST = 2;                                          // B열 : 전일대비_BTC
var CR_STAMP_COL = 2 + (CR_PERIODS.length + 1) * COINS.length; // AP열 : 갱신시각
var CR_TOTAL     = CR_STAMP_COL;                               // 총 42열 (A~AP)

// -- 투자비중 설정 -------------------------------------------
var AL_SHEET     = '투자비중';
var AL_START     = '2020-01-01';   // 첫 적용일 (기준일은 그 전날인 2019-12-31)
var AL_COL_FIRST = 5;              // E열 : 종목별 기여값 시작
var AL_COL_N     = 13;             // M열 : 종목수 N
var AL_COL_W     = 14;             // N열 : 투자비중
var AL_COL_RANK  = 15;             // O열 : 순위 시작 (O~T, 6열)
var AL_COL_STAMP = 21;             // U열 : 갱신시각
var AL_TOTAL     = 21;             // 총 21열 (A~U)
var FMT_CONTRIB  = '#,##0.00%';    // 기여값 (1/N) - 백분율 표기
var FMT_WEIGHT   = '#,##0.00%';    // 투자비중
var FMT_RATIO    = '#,##0.00';     // BTC 가격 / MA120 비율

// -- 투자결과 설정 -------------------------------------------
var RS_SHEET  = '투자결과';
var RS_TOTAL  = 16;                // 총 16열 (A~P)
var FMT_MDD   = '[Blue]#,##0.00%;[Blue]-#,##0.00%;#,##0.00%';   // MDD는 0 이하만 나온다

// -- 월별수익률(계절성) 설정 ---------------------------------
var MO_SHEET  = '월별수익률';
var MO_COIN   = 'BTC';
var MO_TOTAL  = 14;                // A 연도 + 1~12월 + N 연간수익률
var FMT_PROB  = '#,##0.00%';       // 월별 수익확률


// -- 공통 유틸 -----------------------------------------------

/** 업비트 기준 '오늘' 날짜(YYYY-MM-DD). 오전 9시 이전이면 전날로 계산 */
function upbitToday_() {
  var now  = new Date();
  var hour = Number(Utilities.formatDate(now, TZ, 'H'));
  var base = new Date(now.getTime() - (hour < 9 ? 24 * 60 * 60 * 1000 : 0));
  return Utilities.formatDate(base, TZ, 'yyyy-MM-dd');
}

/** 'YYYY-MM-DD' 에 일수를 더한 날짜 문자열 반환 */
function addDays_(dateStr, days) {
  var d = new Date(dateStr + 'T00:00:00+09:00');
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

/** 시트 핸들 획득 (없으면 생성) */
function getSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  return sh;
}

/** 두 날짜 문자열 사이의 일수 차이 (b - a) */
function dayDiff_(a, b) {
  return Math.round(
    (new Date(b + 'T00:00:00+09:00').getTime() - new Date(a + 'T00:00:00+09:00').getTime())
    / 86400000
  );
}

/** 현재 시각 문자열 */
function nowStamp_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}


// -- 업비트 API ----------------------------------------------

/** 8종 현재가 일괄 조회 (API 1회 호출) -> { BTC: 가격, ... } */
function fetchTicker_() {
  var markets = COINS.map(function (c) { return 'KRW-' + c; }).join(',');
  var res = UrlFetchApp.fetch(
    'https://api.upbit.com/v1/ticker?markets=' + markets,
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) {
    throw new Error('현재가 조회 실패(' + res.getResponseCode() + '): ' + res.getContentText());
  }
  var map = {};
  JSON.parse(res.getContentText()).forEach(function (o) {
    map[o.market.replace('KRW-', '')] = o.trade_price;
  });
  return map;
}

/**
 * 특정 종목의 일봉 종가를 fromDate 이전까지 거슬러 수집
 * @return { 'YYYY-MM-DD': 종가, ... }
 */
function fetchDailyCloses_(coin, fromDate) {
  var out = {};
  var to  = '';
  for (var page = 0; page < 60; page++) {
    var url = 'https://api.upbit.com/v1/candles/days?market=KRW-' + coin + '&count=200';
    if (to) url += '&to=' + encodeURIComponent(to);

    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      throw new Error(coin + ' 일봉 조회 실패(' + res.getResponseCode() + '): ' + res.getContentText());
    }
    var arr = JSON.parse(res.getContentText());
    if (!arr.length) break;

    arr.forEach(function (o) {
      out[o.candle_date_time_kst.substring(0, 10)] = o.trade_price;
    });

    var oldest = arr[arr.length - 1];
    if (oldest.candle_date_time_kst.substring(0, 10) <= fromDate) break;
    to = oldest.candle_date_time_utc;   // 다음 페이지는 이 시각 이전
    Utilities.sleep(150);               // 요청 제한(초당 10회) 준수
  }
  return out;
}


// -- 행 구성 -------------------------------------------------

/**
 * 한 행(B~R)의 값 배열 생성
 * @param priceOf  종목->가격 맵 (없으면 상장 전으로 간주해 공란)
 * @param prevRow  직전 행의 B~Q 값 배열 (등락률 기준). 없으면 등락률 공란
 * @param stamp    R열 갱신시각 문자열 (빈 문자열이면 확정 행)
 */
function buildRow_(priceOf, prevRow, stamp) {
  var row = [];
  COINS.forEach(function (c, i) {
    var p = priceOf[c];
    if (p === undefined || p === null || p === '') {
      row.push('');   // 상장 전 구간 -> 공란
      row.push('');
      return;
    }
    row.push(p);
    var prev = prevRow ? prevRow[i * 2] : null;
    row.push((typeof prev === 'number' && prev > 0) ? (p - prev) / prev : '');
  });
  row.push(stamp);
  return row;
}

/** 시트의 마지막 데이터 행 번호 */
function lastDataRow_(sh) {
  return sh.getLastRow();
}

/** 지정 행의 B~Q 값 배열 반환 (등락률 계산 기준용) */
function readPrevRow_(sh, rowNum) {
  if (rowNum < 2) return null;
  return sh.getRange(rowNum, COL_FIRST, 1, COINS.length * 2).getValues()[0];
}

/** 맨 아래에 '현재가 행' 신규 추가 */
function appendCurrentRow_(sh, dateStr) {
  var price = fetchTicker_();
  var last  = lastDataRow_(sh);
  var row   = [dateStr].concat(buildRow_(price, readPrevRow_(sh, last), nowStamp_()));
  sh.getRange(last + 1, COL_DATE, 1, TOTAL_COLS).setValues([row]);
  applyFormat_(sh, last + 1, 1);
}


// -- 서식 ----------------------------------------------------

function applyFormat_(sh, startRow, numRows) {
  sh.getRange(startRow, COL_DATE, numRows, 1).setNumberFormat('@');
  COINS.forEach(function (c, i) {
    sh.getRange(startRow, COL_FIRST + i * 2,     numRows, 1).setNumberFormat(FMT_PRICE);
    sh.getRange(startRow, COL_FIRST + i * 2 + 1, numRows, 1).setNumberFormat(FMT_RATE);
  });
  sh.getRange(startRow, COL_STAMP, numRows, 1).setNumberFormat('@');
}


// -- (1) 최초 적재 -------------------------------------------

function initialLoad() {
  var sh = getSheet_();
  sh.clear();

  // 헤더 구성 : 날짜 | BTC | BTC등락률 | ... | XLM등락률 | 갱신시각
  var header = ['날짜'];
  COINS.forEach(function (c) { header.push(c); header.push(c + '등락률'); });
  header.push('갱신시각');
  sh.getRange(1, 1, 1, TOTAL_COLS).setValues([header]).setFontWeight('bold');
  sh.setFrozenRows(1);

  // 8종 일별 종가 수집
  var closes = {};
  COINS.forEach(function (c) {
    closes[c] = fetchDailyCloses_(c, START_DATE);
    Logger.log(c + ' 일봉 수집 완료 : ' + Object.keys(closes[c]).length + '건');
  });

  // 2020-01-01 ~ 어제(업비트 기준) 확정 행 생성
  var today = upbitToday_();
  var rows  = [];
  var prev  = null;
  for (var d = START_DATE; d < today; d = addDays_(d, 1)) {
    var priceOf = {};
    for (var i = 0; i < COINS.length; i++) {
      var c = COINS[i];
      if (closes[c][d] !== undefined) priceOf[c] = closes[c][d];
    }
    var row = buildRow_(priceOf, prev, '');
    rows.push([d].concat(row));
    prev = row.slice(0, COINS.length * 2);
  }

  sh.getRange(2, COL_DATE, rows.length, TOTAL_COLS).setValues(rows);
  applyFormat_(sh, 2, rows.length);
  SpreadsheetApp.flush();

  // 오늘자 현재가 행 추가
  appendCurrentRow_(sh, today);

  Logger.log('최초 적재 완료 : 확정 ' + rows.length + '행 + 현재가 1행 (' + START_DATE + ' ~ ' + today + ')');
}


// -- (2) 현재가 갱신 (5분 트리거) ----------------------------

function updateCurrent() {
  var sh   = getSheet_();
  var last = lastDataRow_(sh);
  if (last < 2) throw new Error('데이터가 없습니다. initialLoad() 를 먼저 실행하세요.');

  var today    = upbitToday_();
  var lastDate = String(sh.getRange(last, COL_DATE).getValue()).substring(0, 10);

  // 날짜가 바뀌었다면(오전 9시 경과) 확정 절차로 넘김 - 누락 방지 안전장치
  if (lastDate !== today) {
    finalizeDaily();
    return;
  }

  // 맨 아래 한 행만 덮어쓰기 (그 위 확정 구간은 읽지도 쓰지도 않음)
  var price = fetchTicker_();
  var row   = buildRow_(price, readPrevRow_(sh, last - 1), nowStamp_());
  sh.getRange(last, COL_FIRST, 1, TOTAL_COLS - 1).setValues([row]);

  // 이동평균 동기화 - 실패해도 시세 수집은 멈추지 않도록 분리
  // 순서 중요 : 이동평균이 먼저 갱신돼야 변동률·이격도가 최신값을 참조한다
  try { syncMA_(); } catch (e) { Logger.log('이동평균 동기화 실패(현재가): ' + e.message); }
  try { syncChange_(CR_SHEET, 'CR'); } catch (e) { Logger.log('변동률 동기화 실패(현재가): ' + e.message); }
  try { syncChange_(DV_SHEET, 'DV'); } catch (e) { Logger.log('이격도 동기화 실패(현재가): ' + e.message); }
  try { syncAllocation_(); } catch (e) { Logger.log('투자비중 동기화 실패(현재가): ' + e.message); }
  try { syncResult_(); } catch (e) { Logger.log('투자결과 동기화 실패(현재가): ' + e.message); }
  try { syncOrder_(); } catch (e) { Logger.log('오늘매매 동기화 실패(현재가): ' + e.message); }
}


// -- (3) 전일 종가 확정 (매일 09:01 트리거) ------------------

function finalizeDaily() {
  var sh   = getSheet_();
  var last = lastDataRow_(sh);
  if (last < 2) throw new Error('데이터가 없습니다. initialLoad() 를 먼저 실행하세요.');

  var today    = upbitToday_();
  var lastDate = String(sh.getRange(last, COL_DATE).getValue()).substring(0, 10);
  if (lastDate === today) return;   // 이미 처리됨 (멱등)

  // lastDate ~ 어제 구간의 확정 종가 수집
  var closes = {};
  COINS.forEach(function (c) { closes[c] = fetchDailyCloses_(c, lastDate); });

  // (1) 마지막 행을 확정 종가로 고정 + 갱신시각 제거
  var prev = readPrevRow_(sh, last - 1);
  var pOf  = {};
  COINS.forEach(function (c) { if (closes[c][lastDate] !== undefined) pOf[c] = closes[c][lastDate]; });
  var fixed = buildRow_(pOf, prev, '');
  sh.getRange(last, COL_FIRST, 1, TOTAL_COLS - 1).setValues([fixed]);
  prev = fixed.slice(0, COINS.length * 2);

  // (2) 중간 결측일이 있으면 확정 행으로 보정 (스크립트 중단 대비)
  var rows = [];
  for (var d = addDays_(lastDate, 1); d < today; d = addDays_(d, 1)) {
    var po = {};
    for (var i = 0; i < COINS.length; i++) {
      var c = COINS[i];
      if (closes[c][d] !== undefined) po[c] = closes[c][d];
    }
    var r = buildRow_(po, prev, '');
    rows.push([d].concat(r));
    prev = r.slice(0, COINS.length * 2);
  }
  if (rows.length) {
    sh.getRange(last + 1, COL_DATE, rows.length, TOTAL_COLS).setValues(rows);
    applyFormat_(sh, last + 1, rows.length);
    SpreadsheetApp.flush();
  }

  // (3) 오늘자 현재가 행 신규 생성
  appendCurrentRow_(sh, today);

  // 이동평균 동기화 - 실패해도 시세 확정은 멈추지 않도록 분리
  // 순서 중요 : 이동평균이 먼저 갱신돼야 변동률·이격도가 최신값을 참조한다
  try { syncMA_(); } catch (e) { Logger.log('이동평균 동기화 실패(일일확정): ' + e.message); }
  try { syncChange_(CR_SHEET, 'CR'); } catch (e) { Logger.log('변동률 동기화 실패(일일확정): ' + e.message); }
  try { syncChange_(DV_SHEET, 'DV'); } catch (e) { Logger.log('이격도 동기화 실패(일일확정): ' + e.message); }
  try { syncAllocation_(); } catch (e) { Logger.log('투자비중 동기화 실패(일일확정): ' + e.message); }
  try { syncResult_(); } catch (e) { Logger.log('투자결과 동기화 실패(일일확정): ' + e.message); }
  try { syncMonthly_(); } catch (e) { Logger.log('월별수익률 동기화 실패: ' + e.message); }
  try { syncComparison_(); } catch (e) { Logger.log('전략비교 동기화 실패: ' + e.message); }
  try { syncOrder_(); } catch (e) { Logger.log('오늘매매 동기화 실패(일일확정): ' + e.message); }

  Logger.log('일일 확정 완료 : ' + lastDate + ' 종가 고정, ' + today + ' 현재가 행 생성');
}


// -- (4) 트리거 설치 -----------------------------------------

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('updateCurrent').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('finalizeDaily').timeBased().atHour(9).nearMinute(1).everyDays(1).create();
  Logger.log('트리거 설치 완료 : 현재가 5분 주기 / 일일 확정 09:01');
}

/**
 * 트리거 일시 정지 - 전면 재적재 작업 전에 실행한다.
 * 재적재 중 5분 트리거가 끼어들어 데이터가 뒤엉키는 것을 막는다.
 * 작업이 끝나면 반드시 setupTriggers() 로 다시 가동할 것.
 */
function removeTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); n++; });
  Logger.log('트리거 ' + n + '개 정지 완료. 작업 후 setupTriggers() 를 반드시 실행하세요.');
}


// -- (5) 등락률 색상 소급 적용 (1회성 수동 실행) -------------

/**
 * 이미 적재된 기존 행의 등락률 열에 색상 서식을 일괄 적용한다.
 * 상승=빨강 / 하락=파랑 / 보합=검정. 값은 건드리지 않고 표시형식만 변경.
 */
function applyRateColor() {
  var sh   = getSheet_();
  var last = lastDataRow_(sh);
  if (last < 2) throw new Error('데이터가 없습니다. initialLoad() 를 먼저 실행하세요.');

  var rows = last - 1;   // 헤더 제외
  COINS.forEach(function (c, i) {
    sh.getRange(2, COL_FIRST + i * 2 + 1, rows, 1).setNumberFormat(FMT_RATE);
  });
  SpreadsheetApp.flush();
  Logger.log('등락률 색상 적용 완료 : ' + COINS.length + '개 열 x ' + rows + '행');
}


// ============================================================
//  이동평균 (단순이동평균 SMA) - 시트 '이동평균'
// ------------------------------------------------------------
//  · 기간별 묶음 배치 : MA3 8종 -> MA6 8종 -> ... -> MA120 8종
//  · 행 번호는 '일별시세' 시트와 1:1로 정렬됨
//  · 맨 아래 행은 현재가를 반영하므로 5분마다 재계산
//  · 데이터가 n일치 미만이면 공란
// ============================================================

/** 이동평균 시트 핸들 획득 (없으면 생성) */
function getMASheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(MA_SHEET);
  if (!sh) sh = ss.insertSheet(MA_SHEET);
  return sh;
}

/** 이동평균 시트 서식 적용 */
function applyMAFormat_(sh, startRow, numRows) {
  sh.getRange(startRow, COL_DATE, numRows, 1).setNumberFormat('@');
  sh.getRange(startRow, MA_COL_FIRST, numRows, MA_PERIODS.length * COINS.length)
    .setNumberFormat(FMT_MA);
  sh.getRange(startRow, MA_STAMP_COL, numRows, 1).setNumberFormat('@');
}

/**
 * '일별시세'의 특정 행 하나에 대한 이동평균 40개 값을 계산
 * 해당 행을 끝으로 하는 직전 120행까지만 읽어서 계산한다.
 */
function computeMARow_(src, rowNum) {
  var maxP  = MA_PERIODS[MA_PERIODS.length - 1];
  var start = Math.max(2, rowNum - maxP + 1);
  var n     = rowNum - start + 1;
  var data  = src.getRange(start, COL_FIRST, n, COINS.length * 2).getValues();

  var out = [];
  MA_PERIODS.forEach(function (p) {
    COINS.forEach(function (c, i) {
      if (n < p) { out.push(''); return; }
      var sum = 0, ok = true;
      for (var k = n - p; k < n; k++) {
        var v = data[k][i * 2];
        if (typeof v !== 'number') { ok = false; break; }
        sum += v;
      }
      out.push(ok ? sum / p : '');
    });
  });
  return out;
}

/**
 * '이동평균' 시트를 '일별시세'와 동기화한다.
 * 마지막 확정 행부터 최신 행까지만 다시 계산하므로,
 * 그 위의 확정된 과거 구간은 읽지도 쓰지도 않는다.
 */
function syncMA_() {
  var src  = getSheet_();
  var ma   = getMASheet_();
  var sLast = src.getLastRow();
  var mLast = ma.getLastRow();
  if (mLast < 2) return;   // 아직 최초 구축 전 - buildMovingAverage() 필요

  var from = Math.max(2, mLast);
  var rows = [];
  for (var r = from; r <= sLast; r++) {
    var date  = String(src.getRange(r, COL_DATE).getValue()).substring(0, 10);
    var stamp = (r === sLast) ? nowStamp_() : '';
    rows.push([date].concat(computeMARow_(src, r)).concat([stamp]));
  }
  if (!rows.length) return;

  ma.getRange(from, COL_DATE, rows.length, MA_TOTAL).setValues(rows);
  applyMAFormat_(ma, from, rows.length);
}

/**
 * 최초 1회 수동 실행 - 전 구간 이동평균 일괄 계산
 * 슬라이딩 윈도우로 한 번에 계산한 뒤 1000행 단위로 기록한다.
 */
function buildMovingAverage() {
  var src   = getSheet_();
  var sLast = src.getLastRow();
  if (sLast < 2) throw new Error('일별시세 데이터가 없습니다. initialLoad() 를 먼저 실행하세요.');

  var ma = getMASheet_();
  ma.clear();

  // 헤더 : 날짜 | MA3_BTC ... MA3_XLM | MA6_BTC ... | MA120_XLM | 갱신시각
  var header = ['날짜'];
  MA_PERIODS.forEach(function (p) {
    COINS.forEach(function (c) { header.push('MA' + p + '_' + c); });
  });
  header.push('갱신시각');
  ma.getRange(1, 1, 1, MA_TOTAL).setValues([header]).setFontWeight('bold');
  ma.setFrozenRows(1);

  // 원본 일괄 로드 (A: 날짜, B~Q: 가격/등락률)
  var n     = sLast - 1;
  var dates = src.getRange(2, COL_DATE, n, 1).getValues();
  var body  = src.getRange(2, COL_FIRST, n, COINS.length * 2).getValues();

  // 결과 격자 초기화
  var grid = [];
  for (var r = 0; r < n; r++) {
    grid.push(new Array(MA_TOTAL));
    grid[r][0] = String(dates[r][0]).substring(0, 10);
    grid[r][MA_TOTAL - 1] = (r === n - 1) ? nowStamp_() : '';
  }

  // 기간 x 종목별 슬라이딩 윈도우 계산
  var col = 1;
  MA_PERIODS.forEach(function (p) {
    COINS.forEach(function (c, i) {
      var sum = 0, cnt = 0;
      for (var r = 0; r < n; r++) {
        var v = body[r][i * 2];
        if (typeof v === 'number') { sum += v; cnt++; }
        if (r >= p) {
          var old = body[r - p][i * 2];
          if (typeof old === 'number') { sum -= old; cnt--; }
        }
        grid[r][col] = (r >= p - 1 && cnt === p) ? sum / p : '';
      }
      col++;
    });
  });

  // 1000행 단위 기록
  var CHUNK = 1000;
  for (var s = 0; s < n; s += CHUNK) {
    var part = grid.slice(s, Math.min(s + CHUNK, n));
    ma.getRange(2 + s, COL_DATE, part.length, MA_TOTAL).setValues(part);
    applyMAFormat_(ma, 2 + s, part.length);
    SpreadsheetApp.flush();
  }

  Logger.log('이동평균 구축 완료 : ' + n + '행 x ' + (MA_PERIODS.length * COINS.length) + '개 지표');
}


// ============================================================
//  변동률 / 이격도 - 시트 '변동률', '이격도'
// ------------------------------------------------------------
//  두 시트 모두 구조 동일 (42열). 계산 방식만 다르다.
//
//   [공통] 전일대비 블록 (B~I)
//          = (당일 가격 - 전일 가격) / 전일 가격
//
//   [변동률 시트 / mode 'CR'] MA 블록 (J~AO)
//          = (오늘 MAn - 어제 MAn) / 어제 MAn      … 이평선 자체의 기울기
//
//   [이격도 시트 / mode 'DV'] MA 블록 (J~AO)
//          = (당일 가격 - MAn) / MAn               … 가격과 평균선의 괴리
//
//  · 기간 : 3, 6, 12, 60일 (MA120 제외)
//  · 원본 : '일별시세' 가격 열 + '이동평균' 시트 값
// ============================================================

/** 이름으로 시트 핸들 획득 (없으면 생성) */
function getSheetByName_(name) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

/** 변동률·이격도 시트 서식 적용 (등락률과 동일한 색상 서식) */
function applyCRFormat_(sh, startRow, numRows) {
  sh.getRange(startRow, COL_DATE, numRows, 1).setNumberFormat('@');
  sh.getRange(startRow, CR_COL_FIRST, numRows, (CR_PERIODS.length + 1) * COINS.length)
    .setNumberFormat(FMT_RATE);
  sh.getRange(startRow, CR_STAMP_COL, numRows, 1).setNumberFormat('@');
}

/** 헤더 배열 생성 */
function buildCRHeader_(mode) {
  var header = ['날짜'];
  COINS.forEach(function (c) { header.push('전일대비_' + c); });
  CR_PERIODS.forEach(function (p) {
    COINS.forEach(function (c) {
      header.push('MA' + p + (mode === 'DV' ? '이격_' : '변동_') + c);
    });
  });
  header.push('갱신시각');
  return header;
}

/**
 * 한 행의 값 40개를 계산
 * @param pRow   일별시세 B~Q 값 (당일)
 * @param pPrev  일별시세 B~Q 값 (전일). 없으면 null
 * @param mRow   이동평균 B~AO 값 (당일)
 * @param mPrev  이동평균 B~AO 값 (전일). 없으면 null
 * @param mode   'CR' = 이평선 변동률 / 'DV' = 이격도
 */
function computeCRRow_(pRow, pPrev, mRow, mPrev, mode) {
  var out = [];

  // (1) 전일대비 블록 - 두 시트 공통
  COINS.forEach(function (c, i) {
    var p  = pRow[i * 2];
    var pp = pPrev ? pPrev[i * 2] : null;
    out.push((typeof p === 'number' && typeof pp === 'number' && pp > 0) ? (p - pp) / pp : '');
  });

  // (2) MA 블록 - 이동평균 시트의 앞 4블록(3,6,12,60)이 그대로 대응
  CR_PERIODS.forEach(function (per, pi) {
    COINS.forEach(function (c, i) {
      var idx = pi * COINS.length + i;
      var m   = mRow[idx];
      if (mode === 'DV') {
        var p = pRow[i * 2];
        out.push((typeof p === 'number' && typeof m === 'number' && m > 0) ? (p - m) / m : '');
      } else {
        var mp = mPrev ? mPrev[idx] : null;
        out.push((typeof m === 'number' && typeof mp === 'number' && mp > 0) ? (m - mp) / mp : '');
      }
    });
  });

  return out;
}

/**
 * 변동률·이격도 시트를 '일별시세'와 동기화한다.
 * 마지막 확정 행부터 최신 행까지만 다시 계산한다.
 */
function syncChange_(sheetName, mode) {
  var src   = getSheet_();
  var maSh  = getMASheet_();
  var tgt   = getSheetByName_(sheetName);
  var sLast = src.getLastRow();
  var tLast = tgt.getLastRow();
  if (tLast < 2) return;   // 아직 최초 구축 전

  var nCols = COINS.length * 2;
  var mCols = MA_PERIODS.length * COINS.length;
  var from  = Math.max(2, tLast);
  var rows  = [];

  for (var r = from; r <= sLast; r++) {
    var date  = String(src.getRange(r, COL_DATE).getValue()).substring(0, 10);
    var pRow  = src.getRange(r, COL_FIRST, 1, nCols).getValues()[0];
    var pPrev = (r > 2) ? src.getRange(r - 1, COL_FIRST, 1, nCols).getValues()[0] : null;
    var mRow  = maSh.getRange(r, MA_COL_FIRST, 1, mCols).getValues()[0];
    var mPrev = (r > 2) ? maSh.getRange(r - 1, MA_COL_FIRST, 1, mCols).getValues()[0] : null;
    var stamp = (r === sLast) ? nowStamp_() : '';
    rows.push([date].concat(computeCRRow_(pRow, pPrev, mRow, mPrev, mode)).concat([stamp]));
  }
  if (!rows.length) return;

  tgt.getRange(from, COL_DATE, rows.length, CR_TOTAL).setValues(rows);
  applyCRFormat_(tgt, from, rows.length);
}

/** 전 구간 일괄 계산 (공통 로직) */
function buildChange_(sheetName, mode) {
  var src   = getSheet_();
  var maSh  = getMASheet_();
  var sLast = src.getLastRow();
  if (sLast < 2) throw new Error('일별시세 데이터가 없습니다. initialLoad() 를 먼저 실행하세요.');
  if (maSh.getLastRow() !== sLast) {
    throw new Error('이동평균 시트가 일별시세와 어긋나 있습니다. buildMovingAverage() 를 먼저 실행하세요.');
  }

  var tgt = getSheetByName_(sheetName);
  tgt.clear();
  tgt.getRange(1, 1, 1, CR_TOTAL).setValues([buildCRHeader_(mode)]).setFontWeight('bold');
  tgt.setFrozenRows(1);

  var n     = sLast - 1;
  var dates = src.getRange(2, COL_DATE, n, 1).getValues();
  var body  = src.getRange(2, COL_FIRST, n, COINS.length * 2).getValues();
  var mbody = maSh.getRange(2, MA_COL_FIRST, n, MA_PERIODS.length * COINS.length).getValues();

  var grid = [];
  for (var r = 0; r < n; r++) {
    var vals = computeCRRow_(
      body[r],
      r > 0 ? body[r - 1] : null,
      mbody[r],
      r > 0 ? mbody[r - 1] : null,
      mode
    );
    grid.push([String(dates[r][0]).substring(0, 10)]
      .concat(vals)
      .concat([r === n - 1 ? nowStamp_() : '']));
  }

  var CHUNK = 1000;
  for (var s = 0; s < n; s += CHUNK) {
    var part = grid.slice(s, Math.min(s + CHUNK, n));
    tgt.getRange(2 + s, COL_DATE, part.length, CR_TOTAL).setValues(part);
    applyCRFormat_(tgt, 2 + s, part.length);
    SpreadsheetApp.flush();
  }

  Logger.log(sheetName + ' 구축 완료 : ' + n + '행 x ' + ((CR_PERIODS.length + 1) * COINS.length) + '개 지표');
}

/** 최초 1회 수동 실행 - '변동률' 시트 (이평선 자체 변화율) */
function buildChangeRate() {
  buildChange_(CR_SHEET, 'CR');
}

/** 최초 1회 수동 실행 - '이격도' 시트 (가격과 이평선의 괴리율) */
function buildDivergence() {
  buildChange_(DV_SHEET, 'DV');
}


// ============================================================
//  투자비중 - 시트 '투자비중'
// ------------------------------------------------------------
//  기준일 D 의 데이터로 적용일 D+1 의 투자비중을 산출한다.
//
//   N        = 기준일 D에 MA12 값이 있는 종목 수
//   게이트   = BTC 가격(D) >= MA120(D) ? 'ok' : 'pass'
//   종목 기여 = (MA12 보유) AND (MA3(D) >= MA12(D)) -> 1/N, 아니면 0
//   투자비중  = 게이트가 'pass' 면 0
//              게이트가 'ok'  이면 8종 기여값의 합 (최대 1.0)
//
//  · 이 시트만 날짜가 하루 앞서고 행이 1개 많다 (설계상 필연)
//  · 맨 아래 행(= 내일 비중)은 현재가를 반영해 5분마다 변동
//  · 오전 9시에 확정되고 그 아래 새 행이 생성된다
// ============================================================

/** 이동평균 시트에서 특정 기간·종목의 열 위치(0-based) */
function maIndex_(period, coinIdx) {
  return MA_PERIODS.indexOf(period) * COINS.length + coinIdx;
}

/** 투자비중 시트 서식 적용 */
function applyALFormat_(sh, startRow, numRows) {
  sh.getRange(startRow, 1, numRows, 3).setNumberFormat('@');                    // 적용일·기준일·게이트
  sh.getRange(startRow, 4, numRows, 1).setNumberFormat(FMT_RATIO);              // BTC/MA120
  sh.getRange(startRow, AL_COL_FIRST, numRows, COINS.length).setNumberFormat(FMT_CONTRIB);
  sh.getRange(startRow, AL_COL_N, numRows, 1).setNumberFormat('0');
  sh.getRange(startRow, AL_COL_W, numRows, 1).setNumberFormat(FMT_WEIGHT);
  sh.getRange(startRow, AL_COL_RANK, numRows, 6).setNumberFormat('@');           // 순위 6열
  sh.getRange(startRow, AL_COL_STAMP, numRows, 1).setNumberFormat('@');
}

/**
 * 값 배열에서 상위 3개 종목명을 뽑는다.
 * 값이 없는 종목은 제외하고, 동점이면 COINS 배열 순서가 앞선 종목이 우선한다.
 * 3개에 못 미치면 빈 자리는 공란.
 * @param pick  coinIdx -> 값(숫자) 또는 비숫자
 */
function top3_(pick) {
  var list = [];
  COINS.forEach(function (c, i) {
    var v = pick(i);
    if (typeof v === 'number') list.push({ c: c, v: v, i: i });
  });
  list.sort(function (a, b) { return (b.v - a.v) || (a.i - b.i); });
  var out = [];
  for (var k = 0; k < 3; k++) out.push(list[k] ? list[k].c : '');
  return out;
}

/**
 * 기준일 한 행에 대한 투자비중 계산
 * @param pRow  일별시세 B~Q 값 (기준일)
 * @param mRow  이동평균 B~AO 값 (기준일)
 * @param cRow  변동률 B~AO 값 (기준일). 전일대비 블록 0~7, MA3변동 블록 8~15
 * @return [게이트, 비율, 기여값 x8, N, 투자비중, 순위 x6]
 */
function computeAllocRow_(pRow, mRow, cRow) {
  // (1) N = MA12 값이 있는 종목 수
  var hasMA12 = [];
  var N = 0;
  COINS.forEach(function (c, i) {
    var ok = (typeof mRow[maIndex_(12, i)] === 'number');
    hasMA12.push(ok);
    if (ok) N++;
  });

  // (2) 게이트 : BTC 가격 >= BTC MA120
  var btcPrice = pRow[0];
  var btcMA120 = mRow[maIndex_(120, 0)];
  var canJudge = (typeof btcPrice === 'number' && typeof btcMA120 === 'number' && btcMA120 > 0);
  var ratio    = canJudge ? btcPrice / btcMA120 : '';
  var gateOk   = canJudge && (btcPrice >= btcMA120);
  var gate     = gateOk ? 'ok' : 'pass';

  // (3) 종목별 기여값 : MA3 >= MA12 이면 1/N
  var contrib = [];
  var sum = 0;
  COINS.forEach(function (c, i) {
    if (!hasMA12[i] || N === 0) { contrib.push(''); return; }
    var ma3  = mRow[maIndex_(3, i)];
    var ma12 = mRow[maIndex_(12, i)];
    var hit = (typeof ma3 === 'number' && typeof ma12 === 'number' && ma3 >= ma12);
    var v   = hit ? 1 / N : 0;
    contrib.push(v);
    sum += v;
  });

  // (4) 게이트가 pass 면 투자비중 0
  var weight = gateOk ? sum : 0;

  // (5) 순위 - 변동률 시트 기준. 전일대비 블록(0~7), MA3변동 블록(8~15)
  var rank = [];
  if (cRow) {
    rank = top3_(function (i) { return cRow[i]; })
      .concat(top3_(function (i) { return cRow[COINS.length + i]; }));
  } else {
    rank = ['', '', '', '', '', ''];
  }

  return [gate, ratio].concat(contrib).concat([N, weight]).concat(rank);
}

/** 투자비중 시트 헤더 */
function buildALHeader_() {
  var header = ['적용일', '기준일', '게이트', 'BTC/MA120'];
  COINS.forEach(function (c) { header.push(c); });
  header.push('종목수', '투자비중');
  header.push('전일대비1위', '전일대비2위', '전일대비3위');
  header.push('MA3변동1위', 'MA3변동2위', 'MA3변동3위');
  header.push('갱신시각');
  return header;
}

/**
 * '투자비중' 시트를 일별시세와 동기화한다.
 * 마지막 확정 행부터 최신 행까지만 다시 계산한다.
 */
function syncAllocation_() {
  var src   = getSheet_();
  var maSh  = getMASheet_();
  var tgt   = getSheetByName_(AL_SHEET);
  var sLast = src.getLastRow();
  var tLast = tgt.getLastRow();
  if (tLast < 2) return;   // 아직 최초 구축 전

  // 기준일 첫 날짜가 일별시세의 몇 번째 행인지 계산 (날짜는 빈틈 없이 연속)
  var srcFirst   = String(src.getRange(2, COL_DATE).getValue()).substring(0, 10);
  var baseFirst  = addDays_(AL_START, -1);
  var srcStartRow = 2 + dayDiff_(srcFirst, baseFirst);
  if (srcStartRow < 2) throw new Error('일별시세 시작일이 투자비중 기준일보다 늦습니다.');

  var crSh  = getSheetByName_(CR_SHEET);
  var nCols = COINS.length * 2;
  var mCols = MA_PERIODS.length * COINS.length;
  var cCols = (CR_PERIODS.length + 1) * COINS.length;
  var hasCR = (crSh.getLastRow() === sLast);   // 행 수가 어긋나면 순위는 공란 처리
  var rows  = [];
  var startSrcRow = srcStartRow + (tLast - 2);   // 마지막 확정 행에 대응하는 원본 행

  for (var r = startSrcRow; r <= sLast; r++) {
    var base  = String(src.getRange(r, COL_DATE).getValue()).substring(0, 10);
    var pRow  = src.getRange(r, COL_FIRST, 1, nCols).getValues()[0];
    var mRow  = maSh.getRange(r, MA_COL_FIRST, 1, mCols).getValues()[0];
    var cRow  = hasCR ? crSh.getRange(r, CR_COL_FIRST, 1, cCols).getValues()[0] : null;
    var stamp = (r === sLast) ? nowStamp_() : '';
    rows.push([addDays_(base, 1), base]
      .concat(computeAllocRow_(pRow, mRow, cRow))
      .concat([stamp]));
  }
  if (!rows.length) return;

  tgt.getRange(tLast, 1, rows.length, AL_TOTAL).setValues(rows);
  applyALFormat_(tgt, tLast, rows.length);
}

/** 최초 1회 수동 실행 - '투자비중' 시트 전 구간 계산 */
function buildAllocation() {
  var src   = getSheet_();
  var maSh  = getMASheet_();
  var sLast = src.getLastRow();
  if (sLast < 2) throw new Error('일별시세 데이터가 없습니다. initialLoad() 를 먼저 실행하세요.');
  if (maSh.getLastRow() !== sLast) {
    throw new Error('이동평균 시트가 일별시세와 어긋나 있습니다. buildMovingAverage() 를 먼저 실행하세요.');
  }
  var crSh = getSheetByName_(CR_SHEET);
  if (crSh.getLastRow() !== sLast) {
    throw new Error('변동률 시트가 일별시세와 어긋나 있습니다(순위 산출에 필요). buildChangeRate() 를 먼저 실행하세요.');
  }

  var srcFirst    = String(src.getRange(2, COL_DATE).getValue()).substring(0, 10);
  var baseFirst   = addDays_(AL_START, -1);
  var srcStartRow = 2 + dayDiff_(srcFirst, baseFirst);
  if (srcStartRow < 2) {
    throw new Error('일별시세 시작일(' + srcFirst + ')이 기준일(' + baseFirst + ')보다 늦습니다.');
  }

  var tgt = getSheetByName_(AL_SHEET);
  tgt.clear();
  tgt.getRange(1, 1, 1, AL_TOTAL).setValues([buildALHeader_()]).setFontWeight('bold');
  tgt.setFrozenRows(1);

  var n     = sLast - srcStartRow + 1;
  var dates = src.getRange(srcStartRow, COL_DATE, n, 1).getValues();
  var body  = src.getRange(srcStartRow, COL_FIRST, n, COINS.length * 2).getValues();
  var mbody = maSh.getRange(srcStartRow, MA_COL_FIRST, n, MA_PERIODS.length * COINS.length).getValues();
  var cbody = crSh.getRange(srcStartRow, CR_COL_FIRST, n, (CR_PERIODS.length + 1) * COINS.length).getValues();

  var grid = [];
  for (var r = 0; r < n; r++) {
    var base = String(dates[r][0]).substring(0, 10);
    grid.push([addDays_(base, 1), base]
      .concat(computeAllocRow_(body[r], mbody[r], cbody[r]))
      .concat([r === n - 1 ? nowStamp_() : '']));
  }

  var CHUNK = 1000;
  for (var s = 0; s < n; s += CHUNK) {
    var part = grid.slice(s, Math.min(s + CHUNK, n));
    tgt.getRange(2 + s, 1, part.length, AL_TOTAL).setValues(part);
    applyALFormat_(tgt, 2 + s, part.length);
    SpreadsheetApp.flush();
  }

  Logger.log('투자비중 구축 완료 : ' + n + '행 (적용일 ' + AL_START + ' ~ ' + addDays_(String(dates[n - 1][0]).substring(0, 10), 1) + ')');
}


// ============================================================
//  투자결과 - 시트 '투자결과'
// ------------------------------------------------------------
//   투자종목1 = 투자비중 시트 O열 (전일대비 1위)
//   투자종목2 = 투자비중 시트 R열 (MA3변동 1위)
//              └ 종목1과 겹치면 S열 (MA3변동 2위)
//   투자비중  = 해당일 확정 투자비중 / 2  (종목당)
//   수익률    = 일별시세 '적용일' 행의 전일대비 등락률
//   일별수익률 = 수익률1 x 비중1 + 수익률2 x 비중2
//   기간수익률 = 연초부터 (1+일별수익률) 복리 누적 - 1  (매년 1/1 리셋)
//   MDD       = 연초 이후 (지수/연중고점 - 1) 의 최솟값
//
//  · 투자비중 시트와 행 1:1 (마지막 행 = 내일 적용분, 수익률 미발생)
//  · 누적 지표라 5분 갱신 때는 '당해 연도 구간'만 다시 계산한다
// ============================================================

/** 투자결과 시트 헤더 (16열) */
function buildRSHeader_() {
  return ['날짜', '투자종목1', '투자비중', '수익률',
          '투자종목2', '투자비중', '수익률',
          '거래비용', '일별수익률', '기간수익률', 'MDD',
          '투자기간', '상승', '하락', '상승확률', '갱신시각'];
}

/** 투자결과 시트 서식 */
function applyRSFormat_(sh, startRow, numRows) {
  sh.getRange(startRow,  1, numRows, 1).setNumberFormat('@');         // 날짜
  sh.getRange(startRow,  2, numRows, 1).setNumberFormat('@');         // 종목1
  sh.getRange(startRow,  3, numRows, 1).setNumberFormat(FMT_WEIGHT);  // 비중1
  sh.getRange(startRow,  4, numRows, 1).setNumberFormat(FMT_RATE);    // 수익률1
  sh.getRange(startRow,  5, numRows, 1).setNumberFormat('@');         // 종목2
  sh.getRange(startRow,  6, numRows, 1).setNumberFormat(FMT_WEIGHT);  // 비중2
  sh.getRange(startRow,  7, numRows, 1).setNumberFormat(FMT_RATE);    // 수익률2
  sh.getRange(startRow,  8, numRows, 1).setNumberFormat('#,##0.00%'); // 거래비용
  sh.getRange(startRow,  9, numRows, 1).setNumberFormat(FMT_RATE);    // 일별수익률(순)
  sh.getRange(startRow, 10, numRows, 1).setNumberFormat(FMT_RATE);    // 기간수익률
  sh.getRange(startRow, 11, numRows, 1).setNumberFormat(FMT_MDD);     // MDD
  sh.getRange(startRow, 12, numRows, 1).setNumberFormat('#,##0');     // 투자기간
  sh.getRange(startRow, 13, numRows, 1).setNumberFormat('#,##0');     // 상승
  sh.getRange(startRow, 14, numRows, 1).setNumberFormat('#,##0');     // 하락
  sh.getRange(startRow, 15, numRows, 1).setNumberFormat('0.00%');     // 상승확률
  sh.getRange(startRow, 16, numRows, 1).setNumberFormat('@');         // 갱신시각
}

/**
 * 투자비중 시트의 startAlRow 행부터 마지막 행까지 투자결과를 계산한다.
 * 누적 지표는 startAlRow 시점에서 새로 시작하므로,
 * 반드시 '연초 행' 또는 '전체 시작 행'을 startAlRow 로 넘겨야 한다.
 */
function computeResultRows_(startAlRow) {
  var al  = getSheetByName_(AL_SHEET);
  var src = getSheet_();

  var alLast = al.getLastRow();
  if (alLast < 2) throw new Error('투자비중 데이터가 없습니다. buildAllocation() 을 먼저 실행하세요.');
  var n = alLast - startAlRow + 1;
  if (n < 1) return [];

  // 거래비용은 '어제 비중'이 있어야 계산되므로 한 행 앞부터 읽어 직전 보유 상태를 확보한다
  var seed    = (startAlRow > 2) ? 1 : 0;
  var readRow = startAlRow - seed;
  var aBody   = al.getRange(readRow, 1, n + seed, AL_TOTAL).getValues();

  // 일별시세 등락률 색인 (날짜 -> 행 위치)
  var sLast    = src.getLastRow();
  var srcFirst = String(src.getRange(2, COL_DATE).getValue()).substring(0, 10);
  var srcStart = Math.max(2, 2 + dayDiff_(srcFirst, String(aBody[0][0]).substring(0, 10)));
  var srcN     = sLast - srcStart + 1;
  var sDates   = srcN > 0 ? src.getRange(srcStart, COL_DATE,  srcN, 1).getValues() : [];
  var sBody    = srcN > 0 ? src.getRange(srcStart, COL_FIRST, srcN, COINS.length * 2).getValues() : [];
  var pos = {};
  for (var k = 0; k < srcN; k++) pos[String(sDates[k][0]).substring(0, 10)] = k;

  /** 특정 날짜·종목의 전일대비 등락률 */
  function rateOf(date, coin) {
    if (!coin || pos[date] === undefined) return '';
    var ci = COINS.indexOf(coin);
    if (ci < 0) return '';
    var v = sBody[pos[date]][ci * 2 + 1];
    return (typeof v === 'number') ? v : '';
  }

  var rows = [];
  var year = null, idx = 1, peak = 1, mdd = 0;
  var invested = 0, up = 0, down = 0;                 // 연도별 누계
  var prevW = [];
  COINS.forEach(function () { prevW.push(0); });

  for (var i = 0; i < n + seed; i++) {
    var a    = aBody[i];
    var date = String(a[0]).substring(0, 10);
    var y    = date.substring(0, 4);
    var isSeed = (i < seed);                          // 시딩 전용 행은 기록하지 않는다

    if (!isSeed && y !== year) {                      // 매년 1/1 리셋
      year = y; idx = 1; peak = 1; mdd = 0;
      invested = 0; up = 0; down = 0;
    }

    var w  = a[AL_COL_W - 1];                         // N열 : 확정 투자비중
    var c1 = a[AL_COL_RANK + 2];                      // R열 : MA3변동 1위
    var c2 = a[AL_COL_RANK + 3];                      // S열 : MA3변동 2위

    var half = (typeof w === 'number') ? w / 2 : '';
    var r1   = rateOf(date, c1);
    var r2   = rateOf(date, c2);

    // 이번 행의 종목별 비중 벡터 (거래비용 계산용)
    var curW = [];
    COINS.forEach(function () { curW.push(0); });
    if (typeof half === 'number') {
      [c1, c2].forEach(function (name) {
        var k = COINS.indexOf(String(name || ''));
        if (k >= 0) curW[k] += half;
      });
    }

    // 적용일 시세가 아직 없으면(내일 행) 수익률 이후는 전부 공란
    var gross = '', cost = '', daily = '';
    if (pos[date] !== undefined && typeof half === 'number') {
      gross = 0;
      if (typeof r1 === 'number') gross += r1 * half;
      if (typeof r2 === 'number') gross += r2 * half;

      cost = 0;
      COINS.forEach(function (c, k) { cost += Math.abs(curW[k] - prevW[k]) * SC_FEE; });

      daily = gross - cost;
      prevW = curW;
    }

    if (isSeed) continue;                             // 직전 상태만 잡고 넘어간다

    var period = '', drawdown = '';
    var cntI = '', cntU = '', cntD = '', prob = '';
    if (typeof daily === 'number') {
      idx  *= (1 + daily);
      peak  = Math.max(peak, idx);
      mdd   = Math.min(mdd, idx / peak - 1);
      period   = idx - 1;
      drawdown = mdd;

      if (typeof w === 'number' && w > 0) {           // 실제 투자한 날만 집계
        invested++;
        if (daily > 0) up++;
        else if (daily < 0) down++;
      }
      cntI = invested; cntU = up; cntD = down;
      prob = invested ? up / invested : '';
    }

    var stamp = (readRow + i >= alLast - 1) ? nowStamp_() : '';   // 움직이는 2개 행
    rows.push([date, c1 || '', half, r1, c2 || '', half, r2,
               cost, daily, period, drawdown,
               cntI, cntU, cntD, prob, stamp]);
  }
  return rows;
}

/** 당해 연도 첫 행이 투자비중 시트의 몇 번째 행인지 (적용일은 빈틈 없이 연속) */
function yearStartAlRow_(yearStr) {
  var jan1 = yearStr + '-01-01';
  var row  = 2 + dayDiff_(AL_START, jan1);
  return Math.max(2, row);
}

/** 5분·일일 트리거에서 호출 - 당해 연도 구간만 다시 계산 */
function syncResult_() {
  var tgt = getSheetByName_(RS_SHEET);
  if (tgt.getLastRow() < 2) return;   // 아직 최초 구축 전

  var al     = getSheetByName_(AL_SHEET);
  var alLast = al.getLastRow();
  var lastDate = String(al.getRange(alLast, 1).getValue()).substring(0, 10);
  var start  = yearStartAlRow_(lastDate.substring(0, 4));

  var rows = computeResultRows_(start);
  if (!rows.length) return;

  var tgtRow = start;   // 투자비중 행 번호 = 투자결과 행 번호 (1:1 정렬)
  tgt.getRange(tgtRow, 1, rows.length, RS_TOTAL).setValues(rows);
  applyRSFormat_(tgt, tgtRow, rows.length);
}

/** 최초 1회 수동 실행 - 투자결과 전 구간 계산 */
function buildResult() {
  var al  = getSheetByName_(AL_SHEET);
  var src = getSheet_();
  if (al.getLastRow() < 2) throw new Error('투자비중 데이터가 없습니다. buildAllocation() 을 먼저 실행하세요.');
  if (src.getLastRow() < 2) throw new Error('일별시세 데이터가 없습니다. initialLoad() 를 먼저 실행하세요.');

  var tgt = getSheetByName_(RS_SHEET);
  tgt.clear();
  tgt.getRange(1, 1, 1, RS_TOTAL).setValues([buildRSHeader_()]).setFontWeight('bold');
  tgt.setFrozenRows(1);

  var rows = computeResultRows_(2);
  var CHUNK = 1000;
  for (var s = 0; s < rows.length; s += CHUNK) {
    var part = rows.slice(s, Math.min(s + CHUNK, rows.length));
    tgt.getRange(2 + s, 1, part.length, RS_TOTAL).setValues(part);
    applyRSFormat_(tgt, 2 + s, part.length);
    SpreadsheetApp.flush();
  }

  Logger.log('투자결과 구축 완료 : ' + rows.length + '행');
}


// ============================================================
//  월별수익률 (계절성 분석) - 시트 '월별수익률'
// ------------------------------------------------------------
//   세로 = 연도 / 가로 = 1~12월 / 마지막 열(N) = 연간수익률
//   하단 집계 3행 = 월평균 수익률 / 상승·전체 / 월별 수익확률
//
//   월수익률 = (이번 달 종가 - 전월 종가) / 전월 종가
//   · 2017-09는 부분월(9/25 상장)이라 제외
//   · 진행 중인 달은 값은 표시하되 평균·확률 계산에서 제외
//   · 원본은 업비트 월봉 API (일별시세 시트와 무관)
// ============================================================

/** 업비트 월봉 종가 수집 -> { 'YYYY-MM': 종가, ... } */
function fetchMonthlyCloses_(coin) {
  var res = UrlFetchApp.fetch(
    'https://api.upbit.com/v1/candles/months?market=KRW-' + coin + '&count=200',
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) {
    throw new Error(coin + ' 월봉 조회 실패(' + res.getResponseCode() + '): ' + res.getContentText());
  }
  var out = {};
  JSON.parse(res.getContentText()).forEach(function (o) {
    out[o.candle_date_time_kst.substring(0, 7)] = o.trade_price;
  });
  return out;
}

/** 'YYYY-MM' 의 전월 키 */
function prevMonth_(key) {
  var y = Number(key.substring(0, 4));
  var m = Number(key.substring(5, 7)) - 1;
  if (m === 0) { y--; m = 12; }
  return y + '-' + (m < 10 ? '0' + m : '' + m);
}

/**
 * 월별수익률 격자를 계산한다.
 * @return { rows: 연도행 배열, avg: 월평균행, cnt: 상승/전체행, prob: 수익확률행, top3: 상위 3개월 인덱스 }
 */
function computeMonthlyGrid_() {
  var closes  = fetchMonthlyCloses_(MO_COIN);
  var current = upbitToday_().substring(0, 7);   // 진행 중인 달

  var keys = Object.keys(closes).sort();
  if (!keys.length) throw new Error('월봉 데이터를 가져오지 못했습니다.');

  // 월수익률 계산 (전월 종가가 없으면 공란 = 부분월/최초월)
  var ret = {};
  keys.forEach(function (k) {
    var p = closes[prevMonth_(k)];
    ret[k] = (typeof p === 'number' && p > 0) ? (closes[k] - p) / p : '';
  });

  var firstYear = Number(keys[0].substring(0, 4));
  var lastYear  = Number(keys[keys.length - 1].substring(0, 4));

  var rows = [];
  var up = [], tot = [], sum = [];
  for (var m = 0; m < 12; m++) { up.push(0); tot.push(0); sum.push(0); }

  for (var y = firstYear; y <= lastYear; y++) {
    var row  = [String(y)];
    var idx  = 1;
    var any  = false;
    for (var mm = 1; mm <= 12; mm++) {
      var key = y + '-' + (mm < 10 ? '0' + mm : '' + mm);
      var v   = ret[key];
      if (typeof v !== 'number') { row.push(''); continue; }
      row.push(v);
      idx *= (1 + v);
      any = true;
      if (key !== current) {          // 진행 중인 달은 통계에서 제외
        tot[mm - 1]++;
        sum[mm - 1] += v;
        if (v > 0) up[mm - 1]++;
      }
    }
    row.push(any ? idx - 1 : '');     // N열 : 연간수익률
    rows.push(row);
  }

  var avg = ['월평균'], cnt = ['상승/전체'], prob = ['수익확률'];
  for (var j = 0; j < 12; j++) {
    avg.push(tot[j] ? sum[j] / tot[j] : '');
    cnt.push(tot[j] ? (up[j] + '/' + tot[j]) : '');
    prob.push(tot[j] ? up[j] / tot[j] : '');
  }
  avg.push(''); cnt.push(''); prob.push('');

  // 수익확률 상위 3개월 (강조 표시용)
  var rank = [];
  for (var t = 0; t < 12; t++) if (typeof prob[t + 1] === 'number') rank.push({ i: t, v: prob[t + 1] });
  rank.sort(function (a, b) { return (b.v - a.v) || (a.i - b.i); });
  var top3 = rank.slice(0, 3).map(function (o) { return o.i; });

  return { rows: rows, avg: avg, cnt: cnt, prob: prob, top3: top3 };
}

/** 월별수익률 시트 기록 (헤더 아래 데이터 영역만) */
function writeMonthly_(sh, g) {
  var body = g.rows.concat([g.avg, g.cnt, g.prob]);
  sh.getRange(2, 1, body.length, MO_TOTAL).setValues(body);

  var n = g.rows.length;
  sh.getRange(2, 1, body.length, 1).setNumberFormat('@');                 // 연도·집계명
  sh.getRange(2, 2, n, MO_TOTAL - 1).setNumberFormat(FMT_RATE);           // 연도별 수익률
  sh.getRange(2 + n, 2, 1, MO_TOTAL - 1).setNumberFormat(FMT_RATE);       // 월평균
  sh.getRange(3 + n, 2, 1, MO_TOTAL - 1).setNumberFormat('@');            // 상승/전체
  sh.getRange(4 + n, 2, 1, MO_TOTAL - 1).setNumberFormat(FMT_PROB);       // 수익확률

  // 수익확률 상위 3개월 강조
  var probRow = 4 + n;
  sh.getRange(probRow, 2, 1, 12).setFontWeight('normal');
  g.top3.forEach(function (i) { sh.getRange(probRow, 2 + i).setFontWeight('bold'); });

  sh.getRange(2 + n, 1, 3, 1).setFontWeight('bold');
}

/** 매일 09:01 트리거에서 호출 - 진행 중인 달 반영 */
function syncMonthly_() {
  var sh = getSheetByName_(MO_SHEET);
  if (sh.getLastRow() < 2) return;   // 아직 최초 구축 전
  writeMonthly_(sh, computeMonthlyGrid_());
}

/** 최초 1회 수동 실행 - 월별수익률 전 구간 구축 */
function buildMonthly() {
  var sh = getSheetByName_(MO_SHEET);
  sh.clear();

  var header = ['연도'];
  for (var m = 1; m <= 12; m++) header.push(m + '월');
  header.push('연간수익률');
  sh.getRange(1, 1, 1, MO_TOTAL).setValues([header]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);

  var g = computeMonthlyGrid_();
  writeMonthly_(sh, g);
  SpreadsheetApp.flush();

  Logger.log('월별수익률 구축 완료 : ' + g.rows.length + '개 연도 + 집계 3행');
}


// ============================================================
//  전략비교 (6개 전략 백테스트) - 시트 '전략비교'
// ------------------------------------------------------------
//  공통 : BTC MA120 게이트 / 2종목 / 2020-01-01~ / 거래비용 반영
//
//   A    전일대비1위 + MA3변동1위   , 골든크로스 1/N , 매일
//   C    MA3변동률 상위 2종         , 골든크로스 1/N , 매일
//   A+D  A와 동일                   , A x 변동성배수 , 매일
//   C+D  C와 동일                   , C x 변동성배수 , 매일
//   E+D  다기간 모멘텀 상위 2종      , 변동성배수     , 매일
//   A-W  A와 동일                   , A와 동일       , 주 1회(월)
//
//  거래비용 = SUM |오늘비중 - 어제비중| x 0.05%
// ============================================================

var SC_SHEET  = '전략비교';
var SD_SHEET  = '전략설명';
var SC_FEE    = 0.0005;          // 편도 수수료 0.05%
var SC_VOL_N  = 20;              // 변동성 관측일
var SC_VOL_T  = 0.40;            // 목표 연변동성 40%
var MOM_P     = [12, 60, 120];   // 다기간 모멘텀 기간
var MOM_W     = [0.5, 0.3, 0.2]; // 등수 가중치
var SC_TOTAL  = 20;              // A~T (날짜 + 6전략x3열 + 갱신시각)
var SS_SHEET  = '전략비교 요약';   // 요약표 전용 시트

var STRATS = [
  { key: 'A',   name: '급등추종',           sel: 'A', vol: false, weekly: false },
  { key: 'C',   name: '추세가속',           sel: 'C', vol: false, weekly: false },
  { key: 'A+D', name: '급등추종·안정형',    sel: 'A', vol: true,  weekly: false },
  { key: 'C+D', name: '추세가속·안정형',    sel: 'C', vol: true,  weekly: false },
  { key: 'E+D', name: '장기모멘텀·안정형',  sel: 'E', vol: true,  weekly: false },
  { key: 'A-W', name: '급등추종·주간형',    sel: 'A', vol: false, weekly: true  }
];

/** 전략 표시명 : 한글명(코드) */
function stratLabel_(st) {
  return st.name + '(' + st.key + ')';
}

/** 표본 표준편차 */
function stdev_(arr) {
  var n = arr.length;
  if (n < 2) return null;
  var m = 0, i;
  for (i = 0; i < n; i++) m += arr[i];
  m /= n;
  var s = 0;
  for (i = 0; i < n; i++) s += (arr[i] - m) * (arr[i] - m);
  return Math.sqrt(s / (n - 1));
}

/** 값 배열에서 상위 k개 종목 인덱스 (큰 값 우선, 동점은 종목 순서) */
function topK_(vals, k) {
  var list = [];
  vals.forEach(function (v, i) { if (typeof v === 'number') list.push({ v: v, i: i }); });
  list.sort(function (a, b) { return (b.v - a.v) || (a.i - b.i); });
  return list.slice(0, k).map(function (o) { return o.i; });
}

/**
 * 백테스트 원본 데이터 일괄 로드
 * 반환 : 일별시세 가격·등락률, 변동률 MA3변동, 투자비중(게이트·비중·순위)
 */
function loadBacktestData_() {
  var src  = getSheet_();
  var crSh = getSheetByName_(CR_SHEET);
  var alSh = getSheetByName_(AL_SHEET);

  var sLast  = src.getLastRow();
  var alLast = alSh.getLastRow();
  if (sLast < 2)  throw new Error('일별시세 데이터가 없습니다. initialLoad() 를 먼저 실행하세요.');
  if (alLast < 2) throw new Error('투자비중 데이터가 없습니다. buildAllocation() 을 먼저 실행하세요.');
  if (crSh.getLastRow() !== sLast) {
    throw new Error('변동률 시트가 일별시세와 어긋나 있습니다. buildChangeRate() 를 먼저 실행하세요.');
  }

  var n     = sLast - 1;
  var dates = src.getRange(2, COL_DATE, n, 1).getValues();
  var sBody = src.getRange(2, COL_FIRST, n, COINS.length * 2).getValues();
  var cBody = crSh.getRange(2, CR_COL_FIRST, n, (CR_PERIODS.length + 1) * COINS.length).getValues();
  var aBody = alSh.getRange(2, 1, alLast - 1, AL_TOTAL).getValues();

  var d = [];
  for (var i = 0; i < n; i++) d.push(String(dates[i][0]).substring(0, 10));

  // 날짜 -> 일별시세 인덱스
  var pos = {};
  for (i = 0; i < n; i++) pos[d[i]] = i;

  return { n: n, date: d, pos: pos, s: sBody, c: cBody, a: aBody };
}

/** 종목별 20일 실현변동성(연율) 사전 계산 */
function buildVolTable_(D) {
  var vol = [];
  COINS.forEach(function (coin, ci) {
    var arr = [];
    for (var i = 0; i < D.n; i++) {
      if (i < SC_VOL_N - 1) { arr.push(null); continue; }
      var win = [], ok = true;
      for (var k = i - SC_VOL_N + 1; k <= i; k++) {
        var v = D.s[k][ci * 2 + 1];          // 등락률
        if (typeof v !== 'number') { ok = false; break; }
        win.push(v);
      }
      var sd = ok ? stdev_(win) : null;
      arr.push(sd ? sd * Math.sqrt(365) : null);
    }
    vol.push(arr);
  });
  return vol;
}

/** 기준일 idx 에서 다기간 모멘텀 상위 2종 (등수 가중합, 작을수록 우수) */
function pickMomentum_(D, idx) {
  var score = [], valid = [];
  var rets = [];   // rets[기간][종목]

  MOM_P.forEach(function (p) {
    var row = [];
    COINS.forEach(function (c, ci) {
      var now  = D.s[idx][ci * 2];
      var past = (idx - p >= 0) ? D.s[idx - p][ci * 2] : null;
      row.push((typeof now === 'number' && typeof past === 'number' && past > 0)
        ? now / past - 1 : null);
    });
    rets.push(row);
  });

  // 세 기간 모두 계산 가능한 종목만 후보
  COINS.forEach(function (c, ci) {
    valid.push(rets[0][ci] !== null && rets[1][ci] !== null && rets[2][ci] !== null);
    score.push(0);
  });

  MOM_P.forEach(function (p, pi) {
    var list = [];
    COINS.forEach(function (c, ci) { if (valid[ci]) list.push({ v: rets[pi][ci], i: ci }); });
    list.sort(function (a, b) { return (b.v - a.v) || (a.i - b.i); });
    list.forEach(function (o, rank) { score[o.i] += (rank + 1) * MOM_W[pi]; });
  });

  var cand = [];
  COINS.forEach(function (c, ci) { if (valid[ci]) cand.push({ s: score[ci], i: ci }); });
  cand.sort(function (a, b) { return (a.s - b.s) || (a.i - b.i); });   // 작을수록 우수
  return cand.slice(0, 2).map(function (o) { return o.i; });
}

/**
 * 전략 하나를 전 구간 시뮬레이션한다.
 * @return { daily:[], cum:[], mdd:[], gross:[], cost:[], turn: 교체횟수, days: 투자일수 }
 */
function simulateStrategy_(D, vol, st) {
  var out = { date: [], daily: [], cum: [], mdd: [], gross: [], cost: [], turn: 0, days: 0 };
  var idxC = 1, idxG = 1, peak = 1, mdd = 0;
  var prevW = [];                     // 종목별 직전 비중
  COINS.forEach(function () { prevW.push(0); });
  var holdSel = null, holdBase = 0;   // 주간 전략용 보유 상태
  var prevKey = '';

  for (var j = 0; j < D.a.length; j++) {
    var row  = D.a[j];
    var date = String(row[0]).substring(0, 10);          // 적용일
    var base = String(row[1]).substring(0, 10);          // 기준일
    var gate = String(row[2]);
    var bw   = row[AL_COL_W - 1];                        // 확정 투자비중
    if (typeof bw !== 'number') bw = 0;

    var ai = D.pos[date];                                // 적용일 인덱스
    var bi = D.pos[base];                                // 기준일 인덱스
    if (ai === undefined || bi === undefined) continue;   // 내일 행 등은 제외

    // ── 종목 선정 ──────────────────────────────
    var sel;
    var isMonday = (new Date(date + 'T00:00:00+09:00').getDay() === 1);
    if (st.weekly && holdSel && !isMonday) {
      sel  = holdSel;                 // 주중에는 지난 월요일 선택 유지
      bw   = (gate === 'ok') ? holdBase : 0;   // 게이트는 매일 적용
    } else {
      if (st.sel === 'C') {
        var ch = [];
        COINS.forEach(function (c, ci) { ch.push(D.c[bi][COINS.length + ci]); });  // MA3변동 블록
        sel = topK_(ch, 2);
      } else if (st.sel === 'E') {
        sel = pickMomentum_(D, bi);
      } else {
        var c1 = String(row[AL_COL_RANK - 1] || '');     // O열
        var m1 = String(row[AL_COL_RANK + 2] || '');     // R열
        var m2 = String(row[AL_COL_RANK + 3] || '');     // S열
        var c2 = (c1 && m1 === c1) ? m2 : m1;
        sel = [];
        [c1, c2].forEach(function (name) {
          var k = COINS.indexOf(name);
          if (k >= 0 && sel.indexOf(k) < 0) sel.push(k);
        });
      }
      if (st.weekly) { holdSel = sel; holdBase = bw; }
    }

    // ── 비중 결정 ──────────────────────────────
    var mult = 1;
    if (st.vol && sel.length) {
      var vs = [];
      sel.forEach(function (ci) { if (vol[ci][bi]) vs.push(vol[ci][bi]); });
      if (vs.length) {
        var pv = 0;
        vs.forEach(function (v) { pv += v; });
        pv /= vs.length;
        if (pv > 0) mult = SC_VOL_T / pv;
      }
    }
    if (bw > 0) mult = Math.min(mult, 1 / bw);           // 총비중 100% 상한

    var w = [];
    COINS.forEach(function () { w.push(0); });
    var legs = sel.length || 1;
    sel.forEach(function (ci) { w[ci] = (bw * mult) / legs; });

    // ── 수익률·비용 ────────────────────────────
    var gross = 0;
    sel.forEach(function (ci) {
      var r = D.s[ai][ci * 2 + 1];                       // 적용일 등락률
      if (typeof r === 'number') gross += r * w[ci];
    });

    var cost = 0;
    COINS.forEach(function (c, ci) { cost += Math.abs(w[ci] - prevW[ci]) * SC_FEE; });
    prevW = w;

    var net = gross - cost;

    // ── 누적 ───────────────────────────────────
    idxC *= (1 + net);
    idxG *= (1 + gross);
    peak  = Math.max(peak, idxC);
    mdd   = Math.min(mdd, idxC / peak - 1);

    var key = sel.slice().sort().join(',');
    if (key !== prevKey) { out.turn++; prevKey = key; }
    if (bw > 0) out.days++;

    out.date.push(date);
    out.daily.push(net);
    out.cum.push(idxC - 1);
    out.mdd.push(mdd);
    out.gross.push(idxG - 1);
    out.cost.push(cost);
  }
  return out;
}

/** 전략 결과 요약 지표 산출 */
function summarize_(res, dateList, years) {
  var n = res.daily.length;
  if (!n) return {};

  var cum   = res.cum[n - 1];
  var gross = res.gross[n - 1];
  var mdd   = res.mdd[n - 1];

  var totCost = 0, wins = 0, invested = 0;
  for (var i = 0; i < n; i++) {
    totCost += res.cost[i];
    if (res.daily[i] !== 0) { invested++; if (res.daily[i] > 0) wins++; }
  }

  var days  = dayDiff_(dateList[0], dateList[n - 1]) + 1;
  var cagr  = (days > 0) ? Math.pow(1 + cum, 365 / days) - 1 : '';
  var sd    = stdev_(res.daily);
  var mean  = 0;
  for (i = 0; i < n; i++) mean += res.daily[i];
  mean /= n;
  var sharpe = (sd && sd > 0) ? (mean * 365) / (sd * Math.sqrt(365)) : '';

  // 연도별 수익률·MDD·일 최대손실 (매년 1/1 리셋)
  var yr = {}, yMdd = {}, yWorst = {};
  years.forEach(function (y) { yr[y] = 1; yMdd[y] = 0; yWorst[y] = 0; });

  var curY = null, yIdx = 1, yPeak = 1;
  var worst = 0;
  for (i = 0; i < n; i++) {
    var y = dateList[i].substring(0, 4);
    if (yr[y] === undefined) continue;
    if (y !== curY) { curY = y; yIdx = 1; yPeak = 1; }

    var v = res.daily[i];
    yr[y] *= (1 + v);
    yIdx  *= (1 + v);
    yPeak  = Math.max(yPeak, yIdx);
    yMdd[y]   = Math.min(yMdd[y], yIdx / yPeak - 1);
    yWorst[y] = Math.min(yWorst[y], v);
    worst     = Math.min(worst, v);
  }
  var yrOut = {};
  years.forEach(function (y) { yrOut[y] = yr[y] - 1; });

  return {
    cum: cum, gross: gross, mdd: mdd, cagr: cagr, sharpe: sharpe,
    win: invested ? wins / invested : '', turn: res.turn,
    cost: totCost, rows: n, worst: worst,
    year: yrOut, yearMdd: yMdd, yearWorst: yWorst
  };
}

/** 전략비교 시트 서식 */
function applySCFormat_(sh, startRow, numRows) {
  sh.getRange(startRow, 1, numRows, 1).setNumberFormat('@');
  for (var k = 0; k < STRATS.length; k++) {
    var c = 2 + k * 3;
    sh.getRange(startRow, c,     numRows, 1).setNumberFormat(FMT_RATE);   // 일별
    sh.getRange(startRow, c + 1, numRows, 1).setNumberFormat(FMT_RATE);   // 누적
    sh.getRange(startRow, c + 2, numRows, 1).setNumberFormat(FMT_MDD);    // MDD
  }
  sh.getRange(startRow, SC_TOTAL, numRows, 1).setNumberFormat('@');
}

/** 요약표 기록 - 전용 시트 '전략비교 요약' A1부터 */
function writeSummary_(sh, sums, years) {
  var head = ['지표'];
  STRATS.forEach(function (s) { head.push(stratLabel_(s)); });

  // 행 정의 : {label, pick, fmt, kind}
  //   kind : 'sec'=구분선 / 'gap'=빈행 / 'val'=데이터
  var W = STRATS.length;
  var last = years[years.length - 1];
  function yLabel(y) { return y + (y === last ? ' (진행중)' : ''); }

  var spec = [];
  spec.push({ kind: 'sec', label: '■ 종합 성과' });
  spec.push({ label: '누적수익률',        fmt: FMT_RATE,     pick: function (m) { return m.cum; } });
  spec.push({ label: '연평균(CAGR)',      fmt: FMT_RATE,     pick: function (m) { return m.cagr; } });
  spec.push({ label: '최대낙폭(MDD)',     fmt: FMT_MDD,      pick: function (m) { return m.mdd; } });
  spec.push({ label: '일 최대손실',       fmt: FMT_MDD,      pick: function (m) { return m.worst; } });
  spec.push({ label: '샤프비율',          fmt: '0.00',       pick: function (m) { return m.sharpe; } });
  spec.push({ label: '승률',              fmt: '0.00%',      pick: function (m) { return m.win; } });

  spec.push({ kind: 'gap' });
  spec.push({ kind: 'sec', label: '■ 연도별 수익률' });
  years.forEach(function (y) {
    spec.push({ label: yLabel(y), fmt: FMT_RATE, pick: function (m) { return m.year[y]; } });
  });

  spec.push({ kind: 'gap' });
  spec.push({ kind: 'sec', label: '■ 연도별 최대낙폭(MDD)' });
  years.forEach(function (y) {
    spec.push({ label: yLabel(y), fmt: FMT_MDD, pick: function (m) { return m.yearMdd[y]; } });
  });

  spec.push({ kind: 'gap' });
  spec.push({ kind: 'sec', label: '■ 연도별 일 최대손실' });
  years.forEach(function (y) {
    spec.push({ label: yLabel(y), fmt: FMT_MDD, pick: function (m) { return m.yearWorst[y]; } });
  });

  spec.push({ kind: 'gap' });
  spec.push({ kind: 'sec', label: '■ 거래 정보' });
  spec.push({ label: '종목교체 횟수',      fmt: '#,##0',     pick: function (m) { return m.turn; } });
  spec.push({ label: '누적 거래비용',      fmt: '#,##0.00%', pick: function (m) { return m.cost; } });
  spec.push({ label: '비용차감 전 수익률', fmt: FMT_RATE,    pick: function (m) { return m.gross; } });
  spec.push({ label: '거래일수',           fmt: '#,##0',     pick: function (m) { return m.rows; } });

  // 값 구성
  var body = [head];
  spec.forEach(function (s) {
    var row = [s.kind === 'gap' ? '' : s.label];
    for (var k = 0; k < W; k++) {
      row.push((s.kind === 'sec' || s.kind === 'gap') ? '' : s.pick(sums[k]));
    }
    body.push(row);
  });

  var rows = body.length, cols = W + 1;
  sh.clear();
  sh.getRange(1, 1, rows, cols).setValues(body);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 190);
  for (var c = 2; c <= cols; c++) sh.setColumnWidth(c, 130);

  // 헤더
  sh.getRange(1, 1, 1, cols).setFontWeight('bold')
    .setBackground('#404040').setFontColor('#FFFFFF');
  sh.setRowHeight(1, 30);

  // 행별 서식
  spec.forEach(function (s, i) {
    var r = i + 2;
    if (s.kind === 'sec') {
      sh.getRange(r, 1, 1, cols).setBackground('#1F4E79').setFontColor('#FFFFFF').setFontWeight('bold');
      sh.setRowHeight(r, 26);
    } else if (s.kind === 'gap') {
      sh.setRowHeight(r, 8);
    } else {
      sh.getRange(r, 1).setFontWeight('bold');
      sh.getRange(r, 2, 1, W).setNumberFormat(s.fmt).setHorizontalAlignment('right');
    }
  });

  sh.setHiddenGridlines(true);
}

/** 전 구간 시뮬레이션 실행 후 시트 기록 */
function runComparison_(sh, withHeader) {
  var D    = loadBacktestData_();
  var vol  = buildVolTable_(D);
  var res  = STRATS.map(function (st) { return simulateStrategy_(D, vol, st); });

  var dl = res[0].date;
  if (!dl.length) throw new Error('시뮬레이션 대상 구간이 없습니다.');

  var years = [];
  for (var y = Number(dl[0].substring(0, 4)); y <= Number(dl[dl.length - 1].substring(0, 4)); y++) {
    years.push(String(y));
  }

  if (withHeader) {
    var head = ['날짜'];
    STRATS.forEach(function (s) {
      var L = stratLabel_(s);
      head.push(L + '_일별', L + '_누적', L + '_MDD');
    });
    head.push('갱신시각');
    sh.getRange(1, 1, 1, SC_TOTAL).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setFrozenColumns(1);
  }

  var grid = [];
  for (var i = 0; i < dl.length; i++) {
    var row = [dl[i]];
    res.forEach(function (r) { row.push(r.daily[i], r.cum[i], r.mdd[i]); });
    row.push(i === dl.length - 1 ? nowStamp_() : '');
    grid.push(row);
  }

  var CHUNK = 1000;
  for (var s = 0; s < grid.length; s += CHUNK) {
    var part = grid.slice(s, Math.min(s + CHUNK, grid.length));
    sh.getRange(2 + s, 1, part.length, SC_TOTAL).setValues(part);
    applySCFormat_(sh, 2 + s, part.length);
    SpreadsheetApp.flush();
  }

  var sums = res.map(function (r) { return summarize_(r, dl, years); });
  writeSummary_(getSheetByName_(SS_SHEET), sums, years);   // 요약은 전용 시트로
  SpreadsheetApp.flush();
  return { rows: grid.length, sums: sums, years: years };
}

/** 매일 09:01 트리거에서 호출 */
function syncComparison_() {
  var sh = getSheetByName_(SC_SHEET);
  if (sh.getLastRow() < 2) return;   // 아직 최초 구축 전
  runComparison_(sh, false);
}

/** 최초 1회 수동 실행 - 6개 전략 백테스트 */
function buildComparison() {
  var sh = getSheetByName_(SC_SHEET);
  sh.clear();
  var r = runComparison_(sh, true);
  Logger.log('전략비교 구축 완료 : ' + r.rows + '행 x ' + STRATS.length + '개 전략');
  STRATS.forEach(function (st, k) {
    var m = r.sums[k];
    Logger.log('  ' + stratLabel_(st) + ' : 누적 ' + (m.cum * 100).toFixed(1) + '% / MDD ' +
               (m.mdd * 100).toFixed(1) + '% / 교체 ' + m.turn + '회');
  });
}


// ============================================================
//  전략설명 - 시트 '전략설명' (정적 문서, 자동 갱신 없음)
// ============================================================

function buildStrategyDoc() {
  var sh = getSheetByName_(SD_SHEET);
  sh.clear();

  var doc = [
    ['항목'].concat(STRATS.map(function (s) { return stratLabel_(s); })),

    ['전략명',
     '현재 전략 (기준선)', '이평 기울기', '현재 전략 + 변동성조절',
     '이평 기울기 + 변동성조절', '다기간 모멘텀 + 변동성조절', '현재 전략 + 주간 리밸런싱'],

    ['한 줄 정의',
     '어제 많이 오른 종목과 평균선이 가장 가파른 종목을 산다',
     '평균선이 가장 가파르게 상승 중인 2종목을 산다',
     'A와 같은 종목을 사되 시장이 출렁이면 비중을 줄인다',
     'C와 같은 종목을 사되 시장이 출렁이면 비중을 줄인다',
     '단기·중기·장기에서 두루 강한 종목을 산다',
     'A와 같지만 종목 교체를 주 1회로 제한한다'],

    ['종목 선정',
     '전일대비 1위 + MA3변동 1위 (겹치면 MA3변동 2위)',
     'MA3 변동률 상위 2종',
     'A와 동일',
     'C와 동일',
     '12·60·120일 수익률 등수를 0.5/0.3/0.2 가중 합산해 상위 2종',
     'A와 동일 (매주 월요일에만 갱신)'],

    ['비중 결정',
     'MA3 >= MA12 충족 종목수 / N, 두 종목에 절반씩',
     'A와 동일',
     'A의 비중 x (목표변동성 40% / 실현변동성)',
     'C의 비중 x (목표변동성 40% / 실현변동성)',
     'A의 비중 x (목표변동성 40% / 실현변동성)',
     'A와 동일 (월요일 값을 그 주 내내 유지)'],

    ['게이트',
     'BTC 가격 < MA120 이면 비중 0', 'A와 동일', 'A와 동일', 'A와 동일', 'A와 동일',
     'A와 동일 (게이트만은 매일 적용)'],

    ['리밸런싱 주기', '매일', '매일', '매일', '매일', '매일', '주 1회 (월요일 09:00)'],

    ['파라미터',
     'MA3, MA12, MA120',
     'MA3',
     'MA3, MA12, MA120, 관측 20일, 목표변동성 40%',
     'MA3, 관측 20일, 목표변동성 40%',
     '12/60/120일, 가중치 0.5/0.3/0.2, 관측 20일, 목표변동성 40%',
     'MA3, MA12, MA120, 리밸런싱 요일'],

    ['강점',
     '상승장에서 수익이 크다. 논리가 단순해 검증이 쉽다',
     'A보다 신호가 빠르다. 강한 추세 종목에 집중한다',
     '급등락 구간에서 자동으로 위험을 줄여 MDD가 낮아진다',
     'C의 공격성을 변동성 조절로 완화한다',
     '단기 반짝 급등에 속지 않는다. 종목 교체가 적어 거래비용이 낮다',
     '거래비용이 크게 줄어든다. 잦은 매매로 인한 소모를 막는다'],

    ['약점',
     '횡보장에서 헛신호가 잦다. 고점 부근 매수 경향',
     '노이즈에 민감하다. 급반전 시 손실이 커진다',
     '상승장에서 수익 일부를 포기한다. 파라미터가 늘어난다',
     '위와 동일',
     '급락장에서 빠져나오는 속도가 느리다. 상장 120일 미만 종목은 제외된다',
     '주중 급변에 대응하지 못한다 (게이트만 작동)'],

    ['데이터 출처',
     '투자비중 O·R·S열, N열',
     '변동률 시트 MA3변동 블록(J~Q)',
     '투자비중 + 일별시세 등락률',
     '변동률 + 일별시세 등락률',
     '일별시세 종가 + 등락률',
     '투자비중 O·R·S열, N열'],

    ['예상 성격',
     '수익 高 / MDD 高 / 거래 잦음',
     '수익 高 / MDD 高 / 거래 매우 잦음',
     '수익 中 / MDD 低 / 거래 잦음',
     '수익 中 / MDD 低 / 거래 잦음',
     '수익 中 / MDD 中 / 거래 드묾',
     '수익 中 / MDD 高 / 거래 드묾'],

    ['', '', '', '', '', '', ''],
    ['■ 공통 고정 조건', '', '', '', '', '', ''],
    ['시작일', '2020-01-01 (적용일 기준)', '', '', '', '', ''],
    ['종목 수', '항상 2종목', '', '', '', '', ''],
    ['게이트', 'BTC 가격이 자기 MA120 아래면 전 전략 비중 0', '', '', '', '', ''],
    ['비중 상한', '총 100% (레버리지 없음)', '', '', '', '', ''],
    ['수익률 시점', '적용일 당일의 전일대비 등락률 (익일 09:00에 확정)', '', '', '', '', ''],

    ['', '', '', '', '', '', ''],
    ['■ 거래비용 모델', '', '', '', '', '', ''],
    ['계산식', '일별 비용 = SUM |오늘 비중(i) - 어제 비중(i)| x 0.05%', '', '', '', '', ''],
    ['수수료율', '업비트 기본 0.05% (편도). 슬리피지는 미반영', '', '', '', '', ''],
    ['적용', '실제 매매가 일어난 금액에만 부과. 종목이 그대로면 비용 0', '', '', '', '', ''],
    ['최종 수익률', '순수익률 = 총수익률 - 거래비용', '', '', '', '', ''],

    ['', '', '', '', '', '', ''],
    ['■ 성과지표 정의', '', '', '', '', '', ''],
    ['누적수익률', '전체 기간 복리 누적 (거래비용 차감 후)', '', '', '', '', ''],
    ['연도별 수익률', '각 연도를 100에서 새로 시작해 그해 복리 누적', '', '', '', '', ''],
    ['연평균(CAGR)', '(1+누적수익률)^(365/경과일수) - 1', '', '', '', '', ''],
    ['최대낙폭(MDD)', '전체 기간 중 고점 대비 최대 하락폭 (0 이하)', '', '', '', '', ''],
    ['승률', '투자한 날 중 순수익률이 양수인 날의 비율', '', '', '', '', ''],
    ['샤프비율', '연환산 평균수익률 / 연환산 표준편차 (무위험수익률 0 가정)', '', '', '', '', ''],
    ['변동성', '최근 20일 일별등락률 표준편차 x √365 (연율화)', '', '', '', '', ''],

    ['', '', '', '', '', '', ''],
    ['■ 해석 시 주의사항', '', '', '', '', '', ''],
    ['1', '백테스트 성적이 좋다고 실전 성적이 좋은 것은 아니다. 과거에 맞춘 결과일 수 있다', '', '', '', '', ''],
    ['2', '파라미터를 여러 개 시험해 가장 좋은 것을 고르면 과최적화다. 파라미터가 적은 전략이 실전에 강하다', '', '', '', '', ''],
    ['3', '슬리피지·호가 스프레드는 반영되지 않았다. 실전 수익률은 이보다 낮을 수 있다', '', '', '', '', ''],
    ['4', '2020~2021년은 시장 성격이 지금과 크게 달랐다. 최근 연도 성적을 더 무겁게 볼 것', '', '', '', '', ''],
    ['5', '전 전략이 같은 8종목·같은 게이트를 쓰므로 서로 상관관계가 높다. 분산 효과를 과신하지 말 것', '', '', '', '', '']
  ];

  sh.getRange(1, 1, doc.length, 7).setValues(doc);
  sh.getRange(1, 1, 1, 7).setFontWeight('bold');
  sh.getRange(1, 1, doc.length, 1).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 130);
  for (var c = 2; c <= 7; c++) sh.setColumnWidth(c, 260);
  sh.getRange(1, 1, doc.length, 7).setVerticalAlignment('top').setWrap(true);

  SpreadsheetApp.flush();
  Logger.log('전략설명 구축 완료 : ' + doc.length + '행');
}


// ============================================================
//  전체 서식 재적용 - 값은 건드리지 않고 표시형식만 통일
// ------------------------------------------------------------
//  천 단위 쉼표 + 소수점 둘째 자리 규칙을 8개 시트에 일괄 적용
// ============================================================

/**
 * 라벨에 따라 행 서식을 정해준다.
 * @param mode 직전에 만난 '■ …' 구분선 라벨 (없으면 null)
 */
function formatByLabel_(label, mode) {
  var s = String(label);
  var m = String(mode || '');
  if (/^\d{4}/.test(s) && (m.indexOf('MDD') >= 0 || m.indexOf('일 최대손실') >= 0)) return FMT_MDD;
  if (/^\d{4}/.test(s))                 return FMT_RATE;      // 연도 행
  if (s === '일 최대손실')               return FMT_MDD;
  if (s === '누적수익률')                return FMT_RATE;
  if (s === '연평균(CAGR)')              return FMT_RATE;
  if (s === '비용차감 전 수익률')         return FMT_RATE;
  if (s === '월평균')                    return FMT_RATE;
  if (s === '최대낙폭(MDD)')             return FMT_MDD;
  if (s === '승률')                      return '0.00%';
  if (s === '수익확률')                  return FMT_PROB;
  if (s === '샤프비율')                  return '0.00';
  if (s === '누적 거래비용')              return '#,##0.00%';
  if (s === '종목교체 횟수' || s === '거래일수') return '#,##0';
  if (s === '상승/전체')                 return '@';
  return null;
}

/** 라벨이 붙은 블록(요약·집계)의 서식을 라벨 기준으로 다시 입힌다 */
function reformatLabeled_(sh, labelCol, firstRow, valueCol, numCols) {
  var last = sh.getLastRow();
  if (last < firstRow) return;
  var labels = sh.getRange(firstRow, labelCol, last - firstRow + 1, 1).getValues();
  var mode = null;
  for (var i = 0; i < labels.length; i++) {
    var L = String(labels[i][0]);
    if (L.indexOf('■') === 0) { mode = L; continue; }   // 구분선 → 이후 행의 성격 결정
    var f = formatByLabel_(L, mode);
    if (f) sh.getRange(firstRow + i, valueCol, 1, numCols).setNumberFormat(f);
  }
}

/** 8개 시트 서식 일괄 재적용 (값 변경 없음) */
function reformatAll() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var done = [];

  function rows(sh) { return sh.getLastRow() - 1; }

  // 1) 일별시세
  var sh = ss.getSheetByName(SHEET_NAME);
  if (sh && rows(sh) > 0) { applyFormat_(sh, 2, rows(sh)); done.push(SHEET_NAME); }

  // 2) 이동평균
  sh = ss.getSheetByName(MA_SHEET);
  if (sh && rows(sh) > 0) { applyMAFormat_(sh, 2, rows(sh)); done.push(MA_SHEET); }

  // 3) 변동률 / 4) 이격도
  [CR_SHEET, DV_SHEET].forEach(function (nm) {
    var s2 = ss.getSheetByName(nm);
    if (s2 && rows(s2) > 0) { applyCRFormat_(s2, 2, rows(s2)); done.push(nm); }
  });

  // 5) 투자비중
  sh = ss.getSheetByName(AL_SHEET);
  if (sh && rows(sh) > 0) { applyALFormat_(sh, 2, rows(sh)); done.push(AL_SHEET); }

  // 6) 투자결과
  sh = ss.getSheetByName(RS_SHEET);
  if (sh && rows(sh) > 0) { applyRSFormat_(sh, 2, rows(sh)); done.push(RS_SHEET); }

  // 7) 월별수익률 (연도행 + 집계행 모두 라벨 기준)
  sh = ss.getSheetByName(MO_SHEET);
  if (sh && rows(sh) > 0) {
    reformatLabeled_(sh, 1, 2, 2, MO_TOTAL - 1);
    done.push(MO_SHEET);
  }

  // 8) 전략비교 (일별 데이터 영역)
  sh = ss.getSheetByName(SC_SHEET);
  if (sh && rows(sh) > 0) {
    applySCFormat_(sh, 2, rows(sh));
    done.push(SC_SHEET);
  }

  // 9) 전략비교 요약
  sh = ss.getSheetByName(SS_SHEET);
  if (sh && rows(sh) > 0) {
    reformatLabeled_(sh, 1, 2, 2, STRATS.length);
    done.push(SS_SHEET);
  }

  SpreadsheetApp.flush();
  Logger.log('서식 재적용 완료 : ' + done.join(', ') + ' (' + done.length + '개 시트)');
  Logger.log('※ 값은 변경되지 않았습니다. 표시형식만 갱신했습니다.');
}


// ============================================================
//  오늘매매 - 시트 '오늘매매'
// ------------------------------------------------------------
//  오늘 보유 종목(확정) + 내일 예상 종목(변동중) + 통계적 근거
//  원본 : 투자비중(종목·비중·게이트), 투자결과(수익률 표본)
//  5분마다 갱신
// ============================================================

var OD_SHEET = '오늘매매';
var OD_CACHE_KEY = 'ORDER_JSON_V1';   // 스냅샷 캐시 키
var OD_CACHE_SEC = 21600;             // 캐시 유지 6시간

/** 투자결과 시트에서 매매 통계 산출 */
function orderStats_(rows, fromDate) {
  var v = [];
  rows.forEach(function (r) {
    var date = String(r[0]).substring(0, 10);
    var w    = r[2];    // C열 : 투자비중1
    var d    = r[8];    // I열 : 일별수익률(순)
    if (fromDate && date < fromDate) return;
    if (typeof w === 'number' && w > 0 && typeof d === 'number') v.push(d);
  });

  var n = v.length;
  if (!n) return { n: 0 };

  var up = [], dn = [];
  v.forEach(function (d) { if (d > 0) up.push(d); else if (d < 0) dn.push(d); });

  function avg(a) { if (!a.length) return ''; var s = 0; a.forEach(function (x) { s += x; }); return s / a.length; }
  var au = avg(up), ad = avg(dn);
  var pu = up.length / n, pd = dn.length / n;

  return {
    n: n,
    pUp: pu, pDown: pd,
    avgUp: au, avgDown: ad,
    exp: (typeof au === 'number' ? pu * au : 0) + (typeof ad === 'number' ? pd * ad : 0),
    ratio: (typeof au === 'number' && typeof ad === 'number' && ad !== 0) ? au / Math.abs(ad) : '',
    worst: Math.min.apply(null, v),
    sd: stdev_(v)
  };
}

/** 오늘매매 시트 내용 생성 및 기록 */
/**
 * 오늘매매에 필요한 데이터를 한 번에 수집한다.
 * 시트 기록(writeOrder_)과 웹 API(doGet)가 같은 값을 쓰도록 단일 출처로 둔다.
 */
function orderData_() {
  var al = getSheetByName_(AL_SHEET);
  var rs = getSheetByName_(RS_SHEET);
  var alLast = al.getLastRow();
  if (alLast < 3) throw new Error('투자비중 데이터가 부족합니다. buildAllocation() 을 먼저 실행하세요.');

  // 끝에서 두 행 : 오늘(확정) / 내일(변동중)
  var two = al.getRange(alLast - 1, 1, 2, AL_TOTAL).getValues();

  function pack(row) {
    var w = row[AL_COL_W - 1];
    if (typeof w !== 'number') w = 0;
    return {
      date: String(row[0]).substring(0, 10),
      gate: String(row[2]),
      total: w,
      half: w / 2,
      c1: String(row[AL_COL_RANK + 2] || ''),
      c2: String(row[AL_COL_RANK + 3] || '')
    };
  }
  var T = pack(two[0]), M = pack(two[1]);

  // 오늘 종목의 당일 수익률 (투자결과 같은 행)
  T.r1 = ''; T.r2 = '';
  if (rs.getLastRow() >= alLast - 1) {
    var rr = rs.getRange(alLast - 1, 1, 1, RS_TOTAL).getValues()[0];
    T.r1 = rr[3]; T.r2 = rr[6];
  }

  // 통계 표본
  var stAll = { n: 0 }, st1y = { n: 0 };
  if (rs.getLastRow() > 1) {
    var body = rs.getRange(2, 1, rs.getLastRow() - 1, RS_TOTAL).getValues();
    stAll = orderStats_(body, null);
    st1y  = orderStats_(body, addDays_(T.date, -365));
  }

  return { today: T, tomorrow: M, all: stAll, y1: st1y, stamp: nowStamp_() };
}

function writeOrder_(sh) {
  var D = orderData_();
  var T = D.today, M = D.tomorrow;
  var r1 = T.r1, r2 = T.r2;
  var stAll = D.all, st1y = D.y1;

  var g = [];
  g.push(['■ 오늘  ' + T.date, '게이트', T.gate, '총비중', T.total]);
  g.push(['구분', '종목', '비중', '당일 수익률', '상태']);
  g.push(['종목1', T.c1, T.half, r1, '보유중']);
  g.push(['종목2', T.c2, T.half, r2, '보유중']);
  g.push(['현금', '', 1 - T.total, '', '']);
  g.push(['', '', '', '', '']);

  g.push(['■ 내일  ' + M.date, '게이트', M.gate, '총비중', M.total]);
  g.push(['구분', '종목', '비중', '현재 순위', '상태']);
  g.push(['종목1', M.c1, M.half, 'MA3변동 1위', '변동중']);
  g.push(['종목2', M.c2, M.half, 'MA3변동 2위', '변동중']);
  g.push(['현금', '', 1 - M.total, '', '']);
  g.push(['※ 내일 오전 9시 확정 전까지 순위가 바뀌면 종목도 바뀝니다', '', '', '', '']);
  g.push(['', '', '', '', '']);

  g.push(['■ 매수 시 통계 (추세가속 전략 · 거래비용 차감 후)', '', '', '', '']);
  g.push(['지표', '전체기간', '최근 1년', '', '']);
  g.push(['표본(투자일)', stAll.n, st1y.n, '', '']);
  g.push(['상승확률', stAll.pUp, st1y.pUp, '', '']);
  g.push(['하락확률', stAll.pDown, st1y.pDown, '', '']);
  g.push(['평균 상승폭', stAll.avgUp, st1y.avgUp, '', '']);
  g.push(['평균 하락폭', stAll.avgDown, st1y.avgDown, '', '']);
  g.push(['기대수익률(1일)', stAll.exp, st1y.exp, '', '']);
  g.push(['손익비', stAll.ratio, st1y.ratio, '', '']);
  g.push(['일 최대손실', stAll.worst, st1y.worst, '', '']);
  g.push(['일별 표준편차', stAll.sd, st1y.sd, '', '']);
  g.push(['', '', '', '', '']);
  g.push(['⚠ 위 통계는 과거 평균이며 미래를 보장하지 않습니다.', '', '', '', '']);
  g.push(['⚠ 상승확률은 50% 안팎입니다. 이 전략의 수익은 확률이 아니라 손익비에서 나옵니다.', '', '', '', '']);
  g.push(['갱신시각', nowStamp_(), '', '', '']);

  sh.getRange(1, 1, 60, 10).breakApart();   // 이전 병합 해제 후 재작성
  sh.clear();
  sh.getRange(1, 1, g.length, 5).setValues(g);

  styleOrder_(sh, T, M, g.length);
  SpreadsheetApp.flush();
}

/** 오늘매매 시트 서식 - 보고서 형태 + 모바일 가독성 */
function styleOrder_(sh, T, M, nRows) {
  var NAVY = '#1F4E79', GOLD = '#BF8F00', DGRAY = '#404040';
  var HDR  = '#D9D9D9', LGRAY = '#F2F2F2', YELLOW = '#FFF2CC';
  var GBG  = '#C6EFCE', GFG = '#006100', RBG = '#FFC7CE', RFG = '#9C0006';
  var LINE = '#BFBFBF';

  sh.setHiddenGridlines(true);

  // ── 기본 : 글자 11pt, 세로 가운데 ──
  sh.getRange(1, 1, nRows, 5).setFontSize(11).setVerticalAlignment('middle');

  // ── 열 너비 (합계 520px) ──
  var W = [130, 85, 95, 120, 90];
  W.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });

  // ── 섹션 제목 (1·7·14행) ──
  [[1, NAVY], [7, GOLD], [14, DGRAY]].forEach(function (o) {
    sh.getRange(o[0], 1, 1, 5)
      .setBackground(o[1]).setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(12);
    sh.setRowHeight(o[0], 32);
  });

  // ── 표 헤더 (2·8·15행) ──
  [2, 8, 15].forEach(function (r) {
    sh.getRange(r, 1, 1, 5).setBackground(HDR).setFontWeight('bold').setFontColor('#000000');
    sh.setRowHeight(r, 30);
  });

  // ── 데이터 행 높이 ──
  [3, 4, 5, 9, 10, 11].forEach(function (r) { sh.setRowHeight(r, 28); });
  for (var r = 16; r <= 24; r++) sh.setRowHeight(r, 28);

  // ── 현금 행 ──
  [5, 11].forEach(function (r) { sh.getRange(r, 1, 1, 5).setBackground(LGRAY); });

  // ── 게이트 상태 색 ──
  [[1, T.gate], [7, M.gate]].forEach(function (o) {
    var okGate = (o[1] === 'ok');
    sh.getRange(o[0], 3)
      .setBackground(okGate ? GBG : RBG)
      .setFontColor(okGate ? GFG : RFG)
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
  });

  // ── 기대수익률 행 강조 ──
  sh.getRange(21, 1, 1, 3).setBackground(YELLOW).setFontWeight('bold');

  // ── 테두리 ──
  sh.getRange(2, 1, 4, 5).setBorder(true, true, true, true, true, true, LINE, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(8, 1, 4, 5).setBorder(true, true, true, true, true, true, LINE, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(15, 1, 10, 3).setBorder(true, true, true, true, true, true, LINE, SpreadsheetApp.BorderStyle.SOLID);
  // 블록 외곽 굵은 선
  sh.getRange(1, 1, 5, 5).setBorder(true, true, true, true, null, null, DGRAY, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.getRange(7, 1, 5, 5).setBorder(true, true, true, true, null, null, DGRAY, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.getRange(14, 1, 11, 3).setBorder(true, true, true, true, null, null, DGRAY, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // ── 안내·경고 문구 : 병합 + 줄바꿈 ──
  [12, nRows - 2, nRows - 1].forEach(function (r) {
    sh.getRange(r, 1, 1, 5).merge().setWrap(true)
      .setFontSize(10).setFontColor('#7F7F7F').setFontStyle('italic');
  });
  sh.getRange(nRows - 2, 1, 2, 5).setBackground(YELLOW);
  sh.getRange(12, 1).setBackground('#FFFFFF');

  // ── 갱신시각 ──
  sh.getRange(nRows, 1, 1, 5).setFontSize(9).setFontColor('#7F7F7F');

  // ── 정렬 ──
  sh.getRange(3, 2, 3, 1).setHorizontalAlignment('center');   // 오늘 종목
  sh.getRange(9, 2, 3, 1).setHorizontalAlignment('center');   // 내일 종목
  sh.getRange(3, 3, 3, 1).setHorizontalAlignment('right');
  sh.getRange(9, 3, 3, 1).setHorizontalAlignment('right');
  sh.getRange(3, 4, 2, 1).setHorizontalAlignment('right');
  sh.getRange(16, 2, 9, 2).setHorizontalAlignment('right');
  sh.getRange(9, 4, 2, 1).setHorizontalAlignment('center');   // 현재 순위
  sh.getRange(3, 5, 2, 1).setHorizontalAlignment('center');
  sh.getRange(9, 5, 2, 1).setHorizontalAlignment('center');

  // ── 숫자 서식 ──
  sh.getRange(1, 5).setNumberFormat(FMT_WEIGHT);
  sh.getRange(7, 5).setNumberFormat(FMT_WEIGHT);
  sh.getRange(3, 3, 3, 1).setNumberFormat(FMT_WEIGHT);    // 오늘 비중·현금
  sh.getRange(9, 3, 3, 1).setNumberFormat(FMT_WEIGHT);    // 내일 비중·현금
  sh.getRange(3, 4, 2, 1).setNumberFormat(FMT_RATE);      // 당일 수익률

  sh.getRange(16, 2, 1, 2).setNumberFormat('#,##0');      // 표본
  sh.getRange(17, 2, 2, 2).setNumberFormat('0.00%');      // 상승·하락확률
  sh.getRange(19, 2, 3, 2).setNumberFormat(FMT_RATE);     // 평균상승·하락·기대수익률
  sh.getRange(22, 2, 1, 2).setNumberFormat('0.00');       // 손익비
  sh.getRange(23, 2, 1, 2).setNumberFormat(FMT_RATE);     // 일 최대손실
  sh.getRange(24, 2, 1, 2).setNumberFormat('0.00%');      // 표준편차
}

/** 5분·일일 트리거에서 호출 */
function syncOrder_() {
  var sh = getSheetByName_(OD_SHEET);
  if (sh.getLastRow() < 2) return;   // 아직 최초 구축 전
  writeOrder_(sh);
  // 웹 응답용 스냅샷을 미리 만들어 둔다 (doGet 이 시트를 안 읽게)
  try { saveOrderCache_(); } catch (e) { Logger.log('오늘매매 스냅샷 저장 실패: ' + e.message); }
}

/** 최초 1회 수동 실행 */
function buildOrder() {
  writeOrder_(getSheetByName_(OD_SHEET));
  Logger.log('오늘매매 구축 완료');
}


// ============================================================
//  웹 API - 오늘매매 조회 (GitHub Pages 정적 페이지용)
// ------------------------------------------------------------
//  · 비밀번호는 '스크립트 속성' ACCESS_PW 에만 저장한다.
//    (코드·저장소 어디에도 평문이 남지 않는다)
//  · 브라우저는 비밀번호를 SHA-256 으로 변환해 보내고,
//    서버는 저장된 평문의 해시와 대조한다. 평문은 전송되지 않는다.
//  · 이 함수는 읽기 전용이다. 시트를 수정하지 않는다.
// ============================================================

/** 문자열의 SHA-256 해시(소문자 16진) */
function sha256Hex_(text) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < raw.length; i++) {
    var b = (raw[i] < 0) ? raw[i] + 256 : raw[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

/** JSON 응답 생성 */
function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 웹앱 진입점 - 인증 후 오늘매매 데이터를 JSON 으로 반환 */
function doGet(e) {
  try {
    var props = PropertiesService.getScriptProperties();
    var pw = props.getProperty('ACCESS_PW');
    if (!pw) {
      return jsonOut_({ error: 'setup', message: '스크립트 속성 ACCESS_PW 가 설정되지 않았습니다.' });
    }

    var given = (e && e.parameter && e.parameter.h) ? String(e.parameter.h).toLowerCase() : '';
    if (!given || given !== sha256Hex_(pw)) {
      return jsonOut_({ error: 'unauthorized' });
    }

    // 새로고침(fresh=1)이면 캐시를 무시하고 시트에서 직접 다시 읽는다
    var fresh = (e && e.parameter && String(e.parameter.fresh) === '1');
    if (!fresh) {
      var hit = CacheService.getScriptCache().get(OD_CACHE_KEY);
      if (hit) {
        return ContentService.createTextOutput(hit)
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
    var text = saveOrderCache_();          // 시트 읽어 계산 + 캐시 저장
    return ContentService.createTextOutput(text)
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return jsonOut_({ error: 'server', message: String(err && err.message ? err.message : err) });
  }
}

/** 오늘매매 응답 본문(JSON 문자열) 생성 후 캐시에 저장 */
function saveOrderCache_() {
  var D = orderData_();
  var payload = {
    ok: true,
    stamp: D.stamp,
    source: 'sheet',
    today: {
      date: D.today.date, gate: D.today.gate,
      total: D.today.total, half: D.today.half,
      c1: D.today.c1, c2: D.today.c2,
      r1: (typeof D.today.r1 === 'number') ? D.today.r1 : null,
      r2: (typeof D.today.r2 === 'number') ? D.today.r2 : null
    },
    tomorrow: {
      date: D.tomorrow.date, gate: D.tomorrow.gate,
      total: D.tomorrow.total, half: D.tomorrow.half,
      c1: D.tomorrow.c1, c2: D.tomorrow.c2
    },
    stats: { all: statOut_(D.all), y1: statOut_(D.y1) }
  };
  var text = JSON.stringify(payload);
  try { CacheService.getScriptCache().put(OD_CACHE_KEY, text, OD_CACHE_SEC); } catch (e) {}
  return text;
}

/** 통계 객체를 JSON 안전한 형태로 변환 */
function statOut_(s) {
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
  if (!s || !s.n) return { n: 0 };
  return {
    n: s.n,
    pUp: num(s.pUp), pDown: num(s.pDown),
    avgUp: num(s.avgUp), avgDown: num(s.avgDown),
    exp: num(s.exp), ratio: num(s.ratio),
    worst: num(s.worst), sd: num(s.sd)
  };
}


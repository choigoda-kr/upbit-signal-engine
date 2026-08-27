import sqlite3, pandas as pd
conn = sqlite3.connect('upbit_market_data.db')
print(pd.read_sql_query("SELECT date, price, ma3, ma12 FROM daily_price_data WHERE ticker='KRW-BTC' ORDER BY date DESC LIMIT 10", conn))

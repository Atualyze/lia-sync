import psycopg2
import json

conn = psycopg2.connect("postgresql://evolution:REDACTED_POSTGRES_PASS@localhost:5432/evolution")
cur = conn.cursor()
cur.execute('SELECT "key", "message", to_timestamp("messageTimestamp") FROM "Message" ORDER BY "messageTimestamp" DESC LIMIT 5;')
for row in cur.fetchall():
    key, msg, ts = row
    print(ts, key.get("remoteJid"), key.get("fromMe"), msg.get("conversation"))
conn.close()

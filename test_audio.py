import psycopg2
import json
import urllib.request

try:
    conn = psycopg2.connect("postgresql://evolution:REDACTED_POSTGRES_PASS@localhost:5432/evolution")
    cur = conn.cursor()
    cur.execute('SELECT "key", "message" FROM "Message" WHERE "messageType" = \'audioMessage\' ORDER BY "messageTimestamp" DESC LIMIT 1;')
    row = cur.fetchone()
    if row:
        key, message = row
        payload = json.dumps({"message": {"key": key, "message": message}, "convertToMp4": False}).encode()
        req = urllib.request.Request(
            "http://evolution-api:8080/chat/getBase64FromMediaMessage/lia",
            data=payload,
            headers={"Content-Type": "application/json", "apikey": "REDACTED_EVOLUTION_KEY"}
        )
        res = urllib.request.urlopen(req).read().decode()
        data = json.loads(res)
        b64 = data.get("base64")
        mimetype = data.get("mimetype", "audio/ogg").split(";")[0]

        gemini_payload = json.dumps({
            "contents": [{
                "parts": [
                    {"inlineData": {"mimeType": mimetype, "data": b64}},
                    {"text": "Transcreva o que é falado neste áudio em português com fidelidade total."}
                ]
            }]
        }).encode()

        gem_req = urllib.request.Request(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=AQ.Ab8RN6Jsv6kxnf7dX_2q5ROLAEdAcBJOV5oUHEo0FcsvJpyX0Q",
            data=gemini_payload,
            headers={"Content-Type": "application/json"}
        )
        gem_res = json.loads(urllib.request.urlopen(gem_req).read().decode())
        text = gem_res.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text")
        print("GEMINI AUDIO TRANSCRIPTION:", text)
    else:
        print("NO AUDIO FOUND")
except Exception as e:
    print("ERROR:", e)

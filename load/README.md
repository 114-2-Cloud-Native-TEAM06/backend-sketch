# WebSocket k6 壓力測試

這組腳本用來重現「100 users 分散到 50 個雙人 rooms」的 WebSocket send 壓測。

流程：

1. 透過 REST API 建立 / 登入測試 users。
2. 每 2 個 users 建立 1 個 direct room。
3. 開 100 條 WebSocket 連線。
4. 每條連線固定頻率送 `{ type: "send", request_id, chat_id, body }`。
5. 統計連線成功率、實際送出量、收到 frames、ack p95、ack error rate。
6. 壓測結束後用 SQL 查 DB 最終 Message 筆數。

## 前置條件

先啟動 backend stack：

```bash
cd backend-sketch
docker compose up -d
```

確認服務：

```bash
curl http://localhost:8080/health
```

## 本機有 k6 時

```bash
cd backend-sketch
k6 run load/ws-chat-load.js
```

## 沒有安裝 k6，用 Docker 跑

在 macOS Docker Desktop 上，container 需要用 `host.docker.internal` 連回 host port：

```bash
cd backend-sketch
docker run --rm \
  -v "$PWD/load:/scripts" \
  grafana/k6 run \
  -e API_BASE=http://host.docker.internal:8080 \
  -e WS_BASE=ws://host.docker.internal:8081 \
  -e RUN_ID=$(date +%Y%m%d%H%M%S) \
  -e REPORT_DIR=/scripts/reports \
  /scripts/ws-chat-load.js
```

## 常用參數

```bash
k6 run \
  -e USERS=100 \
  -e DURATION=2m \
  -e SEND_INTERVAL_MS=100 \
  -e SOCKET_LIFE_MS=60000 \
  -e MAX_PENDING_ACKS=1000 \
  -e RUN_ID=$(date +%Y%m%d%H%M%S) \
  load/ws-chat-load.js
```

參數說明：

| 參數 | 預設 | 說明 |
|---|---:|---|
| `USERS` | `100` | WebSocket users 數量，必須是偶數 |
| `DURATION` | `2m` | k6 scenario 總時間 |
| `SEND_INTERVAL_MS` | `100` | 每條 WS 連線每隔幾 ms 送一則訊息。100 users + 100ms 約等於理論 1000 msg/sec |
| `SOCKET_LIFE_MS` | `60000` | 每次 WS iteration 維持多久後關閉重連 |
| `MAX_PENDING_ACKS` | `1000` | 單條 WS 最多 pending ack 數量，超過會跳過送訊息，避免 client 記憶體爆掉 |
| `RUN_ID` | `local` | seed user / request_id 前綴，用來區分不同壓測批次。正式報告建議每次明確指定 |
| `REPORT_DIR` | `load/reports` | 報告輸出資料夾。Docker 跑法請設成 `/scripts/reports` |

## 報告輸出

每次壓測結束會輸出三個檔案：

```text
load/reports/ws-chat-load-<RUN_ID>.txt
load/reports/ws-chat-load-<RUN_ID>.json
load/reports/ws-chat-load-<RUN_ID>.k6-summary.json
```

- `.txt`：適合直接貼到報告或群組。
- `.json`：精簡後的壓測指標，適合留存比較。
- `.k6-summary.json`：k6 原始 summary，適合後續分析。

## 自動測平均送出速率上限

如果想找「穩定平均送出速率上限」，可以跑：

```bash
sh load/find-throughput-ceiling.sh
```

它會依序測：

```text
100ms -> 90ms -> 80ms -> 70ms -> 60ms -> 50ms -> 40ms -> 30ms
```

每輪會：

1. 跑一次 k6。
2. 查本輪 DB 實際寫入 Message 數。
3. 算 `DB count / messages_sent`。
4. 把結果寫到 `load/reports/throughput-ceiling-<RUN_PREFIX>.csv` 和 `.txt`。
5. 如果不符合穩定門檻就停止。

預設穩定門檻：

```text
ack_error_rate <= 1%
ack_p95 <= 1s
DB 寫入比例 >= 98%
```

自訂範例：

```bash
INTERVALS="90 80 70 60 50" \
ACK_ERROR_MAX=1 \
ACK_P95_MAX=1 \
DB_RATIO_MIN=98 \
sh load/find-throughput-ceiling.sh
```

如果想更嚴格：

```bash
ACK_ERROR_MAX=0.1 ACK_P95_MAX=0.5 DB_RATIO_MIN=99 sh load/find-throughput-ceiling.sh
```

## 測一次多少人可以同時上線

這個測項只測 WebSocket 長連線承載，不測訊息寫入吞吐。腳本會建立 users、連上 WS、保持連線、定期送 `ping`，用 `pong` 判斷連線是否健康。

單輪測 1000 人同時在線：

```bash
docker run --rm \
  -v "$PWD/load:/scripts" \
  grafana/k6 run \
  -e API_BASE=http://host.docker.internal:8080 \
  -e WS_BASE=ws://host.docker.internal:8081 \
  -e USERS=1000 \
  -e DURATION=1m \
  -e SOCKET_HOLD_MS=60000 \
  -e PING_INTERVAL_MS=15000 \
  -e RUN_ID=online1000 \
  -e REPORT_DIR=/scripts/reports \
  /scripts/ws-online-load.js
```

輸出：

```text
load/reports/ws-online-load-<RUN_ID>.txt
load/reports/ws-online-load-<RUN_ID>.json
load/reports/ws-online-load-<RUN_ID>.k6-summary.json
```

自動找同時在線上限：

```bash
sh load/find-online-ceiling.sh
```

預設會測：

```text
100 -> 200 -> 500 -> 1000 -> 1500 -> 2000 -> 3000 -> 5000 users
```

預設穩定門檻：

```text
WebSocket connect success >= 99%
unexpected close <= 0
pong success >= 95%
pong p95 <= 1s
```

自訂範例：

```bash
USER_STEPS="500 1000 1500 2000" \
CONNECT_SUCCESS_MIN=99 \
PONG_SUCCESS_MIN=95 \
PONG_P95_MAX=1 \
sh load/find-online-ceiling.sh
```

結果會寫到：

```text
load/reports/online-ceiling-<RUN_PREFIX>.csv
load/reports/online-ceiling-<RUN_PREFIX>.txt
```

## Evaluation Criteria Benchmark

如果要對應作業評分標準中的「粗估每秒 1,000 名使用者各傳送 1 筆訊息」，主要跑這個單次 benchmark 即可：

```bash
docker run --rm \
  -v "$PWD/load:/scripts" \
  grafana/k6 run \
  -e API_BASE=http://host.docker.internal:8080 \
  -e WS_BASE=ws://host.docker.internal:8081 \
  -e API_HEALTH_TIMEOUT_SECONDS=120 \
  -e USERS=1000 \
  -e DURATION=2m \
  -e SEND_INTERVAL_MS=1000 \
  -e SOCKET_LIFE_MS=120000 \
  -e MAX_PENDING_ACKS=20 \
  -e RUN_ID=eval-single-1000u1mps \
  -e REPORT_DIR=/scripts/reports \
  /scripts/ws-chat-load.js
```

這個測項會建立 1,000 個 users、500 個雙人 rooms，並讓每個 user 約每秒送 1 則訊息。輸出：

```text
load/reports/ws-chat-load-eval-single-1000u1mps.txt
load/reports/ws-chat-load-eval-single-1000u1mps.json
load/reports/ws-chat-load-eval-single-1000u1mps.k6-summary.json
```

跑完後查 DB 實際落庫數：

```bash
docker compose exec postgres psql -U admin -d imdb -c \
  "SELECT count(*) FROM \"Message\" WHERE \"requestId\" LIKE 'k6-eval-single-1000u1mps-%';"
```

判讀重點：

- `WebSocket 連線成功率` 接近 100%。
- `平均送出速率` 是否接近 1,000 msg/sec。
- `ack p95 <= 1s`。
- `ack error rate <= 1%`。
- `DB count / messages_sent >= 98%`。

如果也想補充「同時在線人數上限」，再跑 online ceiling：

```bash
WS_PRELOAD_ROOMS=false docker compose up -d --force-recreate app

API_HEALTH_TIMEOUT_SECONDS=120 \
API_BASE=http://host.docker.internal:8080 \
WS_BASE=ws://host.docker.internal:8081 \
ONLINE_USER_STEPS="1000 5000 10000 20000" \
THROUGHPUT_USERS=1000 \
THROUGHPUT_SEND_INTERVAL_MS=1000 \
sh load/evaluation-criteria-benchmark.sh
```

如果報告出現 `WebSocket 連線嘗試：0`，通常不是 WebSocket server 測到 0，而是 k6 在 `setup()` 建立測試 users 時連不到 REST API。先確認：

```bash
docker compose ps
curl http://localhost:8080/health
```

Docker k6 連回本機 backend 時，常見設定：

```bash
# Docker Desktop on macOS
API_BASE=http://host.docker.internal:8080 WS_BASE=ws://host.docker.internal:8081

# Linux Docker host
API_BASE=http://172.17.0.1:8080 WS_BASE=ws://172.17.0.1:8081
```

k6 會先等待 REST `/health`，預設最多 60 秒。若剛重建 app image 或機器較慢，可以拉長：

```bash
API_HEALTH_TIMEOUT_SECONDS=120 sh load/evaluation-criteria-benchmark.sh
```

## 查 DB 最終 Message 筆數

k6 summary 會印出本次 `RUN_ID`。用它查本次壓測實際寫入 DB 的訊息數：

```bash
sh load/count-k6-messages.sh <RUN_ID>
```

或手動查：

```bash
docker compose exec postgres psql -U admin -d imdb -c \
  "SELECT count(*) FROM \"Message\" WHERE \"requestId\" LIKE 'k6-<RUN_ID>-%';"
```

## Summary 欄位解讀

範例：

```text
100 users 分散到 50 個雙人 rooms
結果：

WebSocket 連線成功率：100.00%
實際送出：124,974 messages
平均送出速率：940 msg/sec
實際收到 WS frames：122,551
ack received：6,540
ack p95 ≈ 60.50s
ack error rate ≈ 94.77%
```

解讀：

- `實際送出`：k6 client 實際 `socket.send()` 的次數。
- `平均送出速率`：實際送出數 / test duration。
- `實際收到 WS frames`：收到的所有 WS frames，包含 ack、msg、error、presence 等。
- `ack p95`：send 到收到對應 ack 的第 95 百分位延遲。
- `ack error rate`：送出後未收到 ack 的比例估算，約等於 `(sent - ack_received) / sent`。
- `DB 最終 Message 筆數`：壓測後 PostgreSQL 實際寫入成功的 Message count。

如果 `WebSocket 連線成功率` 高、但 `ack p95` 很高且 DB count 遠低於 sent count，代表 WS server 沒崩，但同步 DB 寫入路徑撐不住該吞吐。

# 可觀測性快速上手（從零到觀測）

從乾淨環境一路到「在 Grafana 看到四種訊號 + 跑壓測找瓶頸」的操作手冊。
搭配 [SIGNALS.md](SIGNALS.md)（每個指標對應什麼事件）與 [../OBSERVABILITY.md](../OBSERVABILITY.md)（設計與調整紀錄）。

> 指令在 **Codespaces / Docker** 用 `docker compose`，本機 Podman 換成 `podman compose` 即可（語法相同）。
> 以下假設你在 repo 根目錄 `backend-sketch/`。

---

## 1. 從頭啟動

```bash
# (0) 一次性：建共用網路
docker network create obs-net

# (1) 起 observability stack（Grafana + Tempo + Mimir + Loki + Pyroscope，一個鏡像）
docker compose -f observability/docker-compose.yml up -d

# (2) 起 app + postgres + redis
docker compose up --build -d

# (3) 建表 + 重生 Prisma client
docker compose exec app npx prisma migrate deploy
docker compose exec app npx prisma generate

# (4) 確認都活著
docker compose ps
curl http://localhost:8080/health        # → {"status":"ok"}
```

- **Grafana**：http://localhost:3000（otel-lgtm 預設免登入）
- 四個資料源（Tempo / Mimir(Prometheus) / Loki / Pyroscope）otel-lgtm 已預先設好。

---

## 2. 匯入 Dashboard（一頁看全部）

Grafana → **Dashboards → New → Import** → 上傳 [dashboards/im-backend-observability.json](dashboards/im-backend-observability.json) → 選 **Prometheus** 資料源 → Import。

七張圖：WS 連線數、訊息/秒、fanout p50/p95、WS 錯誤、DB 查詢/秒、DB 延遲 p50/p95/p99、event loop delay。右上設 **Last 15 minutes + 10s 自動刷新**。

---

## 3. 製造流量

### 3a. 手動打幾發 REST（PowerShell）
```powershell
# 註冊 + 登入拿 token
$u = @{ username='alice'; email='alice@x.com'; password='secret123'; display_name='Alice' } | ConvertTo-Json
Invoke-RestMethod -Method Post http://localhost:8080/api/v1/auth/register -ContentType 'application/json' -Body $u
$token = (Invoke-RestMethod -Method Post http://localhost:8080/api/v1/auth/login -ContentType 'application/json' `
          -Body (@{ email='alice@x.com'; password='secret123' } | ConvertTo-Json)).token
# 列 chat 幾次（觸發 DB 查詢）
1..10 | % { Invoke-RestMethod http://localhost:8080/api/v1/chats -Headers @{ Authorization = "Bearer $token" } | Out-Null }
```

### 3b. WS 負載產生器（單階段，點亮 WS 指標）
[`scripts/ws-load.mjs`](../backend/scripts/ws-load.mjs) —— 開 N 條 WS 連線狂送訊息。
```bash
# 預設 30 連線 / 30 秒 / 每 0.5s 一則
docker compose exec app node scripts/ws-load.mjs

# 加重（注意 docker compose exec 的 env 要用 -e）
docker compose exec -e CONNECTIONS=80 -e SEND_INTERVAL_MS=200 -e DURATION_MS=60000 app node scripts/ws-load.mjs
```
| env | 預設 | 意義 |
|---|---|---|
| `CONNECTIONS` | 30 | 同時 WS 連線數 |
| `DURATION_MS` | 30000 | 持續時間 |
| `SEND_INTERVAL_MS` | 500 | 每個 client 送訊息的間隔 |

### 3c. 兩階段壓測（分開看登入 vs 傳訊息瓶頸）
[`scripts/ws-stress.mjs`](../backend/scripts/ws-stress.mjs) —— 先「登入風暴」再「訊息風暴」，各印起訖時間戳。
```bash
docker compose exec app node scripts/ws-stress.mjs
# 加重
docker compose exec -e USERS=80 -e LOGIN_CONCURRENCY=40 -e SEND_INTERVAL_MS=100 app node scripts/ws-stress.mjs
```
| env | 預設 | 意義 |
|---|---|---|
| `USERS` | 50 | 帳號池 / WS 連線數 |
| `LOGIN_CONCURRENCY` | 20 | Phase 1 並行登入 worker 數 |
| `LOGIN_MS` | 20000 | Phase 1 登入風暴時間 |
| `MSG_MS` | 30000 | Phase 2 訊息風暴時間 |
| `SEND_INTERVAL_MS` | 200 | Phase 2 每連線送訊息間隔 |

輸出會印 `PHASE 1 START/END`、`PHASE 2 START/END` 時間戳 + 登入延遲(avg/p50/p95/max) + 訊息 sent/ack/recv。

### 3d. k6 版壓測（推薦，含 VU / scenario / threshold）
k6 是 Grafana 的負載測試工具(獨立執行檔,非 Node)。用官方 docker 鏡像跑、**加入 app 的 compose 網路**直接打 service 名：

```bash
# 先查網路名(通常是 backend-sketch_default)
docker network ls   # 找 *_default

# 兩階段壓測（登入風暴 → 訊息風暴，分開的 scenario）
docker run --rm --network backend-sketch_default -v "${PWD}/backend/scripts:/scripts" \
  grafana/k6 run /scripts/k6-stress.js -e API_URL=http://app:8080/api/v1 -e WS_URL=ws://app:8081

# 單純訊息 ramp（連線數階梯）
docker run --rm --network backend-sketch_default -v "${PWD}/backend/scripts:/scripts" \
  grafana/k6 run /scripts/k6-load.js -e API_URL=http://app:8080/api/v1 -e WS_URL=ws://app:8081
```
> Windows Docker Desktop 也可改打 host：`-e API_URL=http://host.docker.internal:8080/api/v1 -e WS_URL=ws://host.docker.internal:8081`（就不用指定 `--network`）。
> PowerShell 把 `${PWD}` 換成 `${PWD}`（PowerShell 支援）或 `$(pwd)`。

| 腳本 | 對應 | 主要 env |
|---|---|---|
| [`scripts/k6-stress.js`](../backend/scripts/k6-stress.js) | 兩階段(登入 + 訊息) | `USERS`、`LOGIN_VUS`、`MSG_VUS`、`MSG_DURATION`、`MSG_START`、`SEND_INTERVAL_MS` |
| [`scripts/k6-load.js`](../backend/scripts/k6-load.js) | 訊息連線 ramp | `USERS`、`SEND_INTERVAL_MS`、`WS_HOLD_MS` |

k6 自己會印 client 端摘要(http p95、checks 通過率、`im_ws_sent/acked/received` counter);**伺服器端**的瓶頸一樣去 Grafana 看(下一節)。Phase 1 / Phase 2 在 dashboard 上靠「WS 連線數那張」分辨(登入階段=0,訊息階段=N)。

> 註:`.mjs` 版(`ws-load.mjs` / `ws-stress.mjs`)是**免安裝 k6** 的備援,直接 `docker compose exec app node scripts/ws-*.mjs` 就能跑,兩者擇一即可。

---

## 4. 在 Grafana 觀測什麼（輸入什麼看什麼）

Grafana → **Explore** → 左上選資料源。

### 📊 Metrics（資料源：Prometheus）
切 **Code** 模式貼查詢：
```promql
# WS 連線數的視窗峰值（gauge 跑完歸 0，用 max_over_time 看高點）
max_over_time(im_ws_active_connections[15m])

# 每秒送出訊息數
rate(im_messages_sent_total[1m])

# 訊息 fanout p95（ms）
histogram_quantile(0.95, sum(rate(im_message_fanout_duration_milliseconds_bucket[1m])) by (le))

# DB 查詢 p95 延遲（spec 的 DB 瓶頸）
histogram_quantile(0.95, sum(rate(im_db_query_duration_milliseconds_bucket[5m])) by (le))

# 每秒 DB 查詢數
rate(im_db_query_duration_milliseconds_count[1m])

# ★ event loop lag（Node 撐不撐得住的核心）
nodejs_eventloop_delay_p99_seconds

# 列出所有自訂指標
{__name__=~"im_.+"}
```

### 🔍 Traces（資料源：Tempo）
- **Query type → Search** → Service Name 選 `im-backend` → Run query → 點任一 trace 看 waterfall。
- 或 **TraceQL**：`{ resource.service.name = "im-backend" }`、只看某 API：`{ span.http.route = "/api/v1/chats" }`
- WS 訊息：找 span 名 `im.message.receive`。

### 📝 Logs（資料源：Loki）
```logql
{service_name="im-backend"}                          # 全部 log
{service_name="im-backend"} |= "slow db query"       # 慢查詢
{service_name="im-backend"} | json | trace_id != ""  # 有 trace_id 的（可跳 trace）
```

### 🔥 Profiles（資料源：Pyroscope）
- **Profile type 選 `wall`**（不是 process_cpu —— `Pyroscope.start()` 只啟 wall+heap），查詢 `{service_name="im-backend"}`。
- 時間範圍框「壓測那段」（或單獨框 ws-stress 的 Phase 1 / Phase 2）。
- Search 框打函式名（如 `writev`、`bcrypt`）會高亮；右上 **Top Table** 依自身 CPU 排序最好讀。

---

## 5. 找瓶頸的標準流程

```
1. 看 dashboard：哪個時段 event loop delay↑ / DB p95↑ / fanout p95↑
2. 框那個時段的 Pyroscope wall profile
3. 看最寬的格子 = 卡住 event loop 的函式
4. 對照原始碼修 → 重跑壓測 → 比前後
```
範例（已實測）：event loop delay 12.9s → wall 看到 Prisma `readFileSync` → 移除 tracing preview → 解決。
其他潛在瓶頸見 [SIGNALS.md 的潛在瓶頸清單](SIGNALS.md#-潛在瓶頸清單推測可用上面的訊號驗證)。

---

## 6. 關閉 / 開關

| 需求 | 做法 |
|---|---|
| 完全關可觀測性 | app 環境變數加 `OBSERVABILITY_ENABLED=false`，`docker compose up -d app`（用 `up` 不是 `restart` 才吃新 env） |
| 只關 profiling | `PROFILING_ENABLED=false` |
| 只關 log 上傳 | `OTEL_LOGS_DISABLED=true` |
| 慢查詢門檻 | `DB_SLOW_QUERY_MS=<ms>`（預設 100） |

臨時關（不動原 compose）：建 `docker-compose.override.yml`：
```yaml
services:
  app:
    environment:
      - OBSERVABILITY_ENABLED=false
```
然後 `docker compose up -d app`；還原就刪掉這個檔再 `up -d app`。

---

## 7. 收掉

```bash
docker compose down                                   # 停 app stack
docker compose -f observability/docker-compose.yml down   # 停 observability stack
# 加 -v 連 volume(資料)一起刪：docker compose ... down -v
```

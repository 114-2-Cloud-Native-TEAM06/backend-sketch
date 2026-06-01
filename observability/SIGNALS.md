# 可觀測訊號對照表（SIGNALS）

這份是「**有哪些資料可以觀測，分別對應哪些事件、從哪裡產生**」的查詢手冊。
搭配 [OBSERVABILITY.md](../OBSERVABILITY.md)（計畫 + 部署 runbook）一起看。

四種訊號在 Grafana 的位置（Explore → 選資料源）：

| 訊號 | 資料源 | 看什麼 |
|------|--------|--------|
| Metrics  | **Prometheus**（otel-lgtm 內建，底層 Mimir） | 數字趨勢、p95/p99 |
| Traces   | **Tempo**     | 單一請求的完整鏈路 |
| Logs     | **Loki**（查 `{service_name="im-backend"}`） | 結構化 log，帶 trace_id |
| Profiles | **Pyroscope**（app = `im-backend`） | CPU/wall 火焰圖找熱點 |

---

## 📊 Metrics

### 自訂 IM 指標（手動埋點）

| Metric（Prometheus 名稱） | 型別 | 對應事件 | 產生位置 |
|---|---|---|---|
| `im_ws_active_connections` | gauge | 目前有幾條 WS 連線 | 每 ~10s 讀 presence store；連線增減時變動 |
| `im_messages_sent_total` | counter | 一則 WS 訊息成功存檔 + ack | `handleSend` 成功時 +1 |
| `im_message_fanout_duration_milliseconds_{bucket,count,sum}` | histogram | 廣播一則訊息給房間所有 socket 的耗時 | `handleSend` 的 `broadcastToRoom` 前後計時 |
| `im_ws_errors_total`（label `reason`） | counter | WS 處理出錯 | 驗證失敗 / internal_error / connection_setup |
| `im_db_query_duration_milliseconds_{bucket,count,sum}` | histogram | **每一筆 Prisma SQL 查詢**的耗時 | `createPrismaClient` 的 `$on('query')`（`shared/db/prisma.ts`） |

### 自動指標（OTel runtime / http instrumentation）

| Metric 前綴 | 對應事件 |
|---|---|
| `nodejs_eventloop_delay_{mean,p50,p99,max,min}_seconds` | **event loop 被卡多久**（單執行緒健康度核心） |
| `nodejs_eventloop_utilization` | event loop 使用率 |
| `v8js_gc_*` | V8 垃圾回收次數/時間（GC 暫停） |
| `v8js_memory_heap_*` / `nodejs_memory_*` | heap 使用量（長連線吃記憶體） |
| `http_server_*`（label：method/route/status） | **每個 REST 請求**的延遲與狀態碼 |

> 確切名稱用 metric browser 打 `{__name__=~"nodejs_.+"}`、`{__name__=~"http_.+"}`、`{__name__=~"im_.+"}` 列出。

### 好用的起手式查詢

```promql
# DB 查詢 p95 延遲（spec 的 DB 瓶頸）
histogram_quantile(0.95, sum(rate(im_db_query_duration_milliseconds_bucket[5m])) by (le))

# 每秒送出訊息數
rate(im_messages_sent_total[1m])

# 訊息 fanout p95
histogram_quantile(0.95, sum(rate(im_message_fanout_duration_milliseconds_bucket[1m])) by (le))

# WS 連線數的視窗峰值（gauge 跑完歸 0，用 max_over_time 看高點）
max_over_time(im_ws_active_connections[15m])

# event loop lag（Node 撐不撐得住的核心指標）
nodejs_eventloop_delay_p99_seconds
```

一頁看全部：匯入 [dashboards/im-backend-observability.json](dashboards/im-backend-observability.json)。

---

## 🔍 Traces（Tempo）

| Span 名稱 | 對應事件 | 來源 |
|---|---|---|
| `GET/POST /api/v1/...` | 每個 REST 請求的完整處理 | http/express 自動埋點 |
| `im.message.receive` | **每則 WS `send` 訊息**的接收處理（attr：`im.chat_id`、`im.sender_id`） | `handleSend` 手動 span |
| `tcp.connect` | 對外 TCP 連線（DB / redis / OTLP） | net 自動埋點 |

- 所有 span 的 URL/attribute 都經 `RedactingSpanProcessor` 洗掉 `?token=`（JWT 不外洩）。
- ⚠️ Prisma SQL span **不可用**：`@prisma/instrumentation` 與 OTel SDK 2.x 不相容（會 crash），已改用 `im_db_query_duration` metric 觀測 DB。

---

## 📝 Logs（Loki，查 `{service_name="im-backend"}`）

所有 log 都是 pino JSON，在請求情境下帶 `trace_id` / `span_id`（可從 log 跳到對應 trace）。

| log `msg` | 對應事件 | 來源 |
|---|---|---|
| `REST server running` / `WebSocket server running` | 服務啟動 | `index.ts` / `realtime.server.ts` |
| `shutting down` | 收到 SIGTERM/SIGINT，優雅關閉 | `index.ts` |
| `unhandled request error` | REST 回 500 的未預期錯誤 | `error-middleware.ts` |
| `ws send failed` | WS 送訊息時內部錯誤 | `handleSend` catch |
| `ws connection setup failed` | WS 連線建立階段出錯 | connection handler |
| `slow db query`（warn） | 查詢 ≥ `DB_SLOW_QUERY_MS`（預設 100ms） | `$on('query')`（帶 `duration_ms`+`query`，**不含 params**） |

---

## 🔥 Profiles（Pyroscope，app = `im-backend`）

| Profile type | 對應 | 怎麼啟動 |
|---|---|---|
| `wall`（wall-clock） | **含 I/O 等待**的實際耗時 → 找「卡住 event loop」的東西 | `Pyroscope.start()`（預設啟動） |
| heap / `inuse_space` | 記憶體配置熱點 | `Pyroscope.start()`（預設啟動） |
| `process_cpu` | 純 CPU 時間 | 目前未啟（需 `startCpuProfiling()`） |

**wall vs cpu**：wall = 真實流逝時間（含等待），cpu = 只算 CPU 真的在運算。找單執行緒阻塞瓶頸**看 wall**（同步 I/O、被卡住的等待都抓得到）；看純運算熱點才看 cpu。

> 注意：`Pyroscope.start()` 只啟 wall + heap，**不啟 process_cpu**。Grafana 的 profile type 要選 **`wall`** 才看得到 im-backend 資料。

---

## 🧪 壓測腳本

| 腳本 | 用途 |
|---|---|
| [scripts/ws-load.mjs](../backend/scripts/ws-load.mjs) | 開 N 條 WS 連線狂送訊息（單階段）。env：`CONNECTIONS`/`DURATION_MS`/`SEND_INTERVAL_MS` |
| [scripts/ws-stress.mjs](../backend/scripts/ws-stress.mjs) | **兩階段**：登入風暴 → 訊息風暴，各印起訖時間戳。env：`USERS`/`LOGIN_CONCURRENCY`/`LOGIN_MS`/`MSG_MS`/`SEND_INTERVAL_MS` |

在容器內跑：`docker compose exec app node scripts/ws-stress.mjs`

---

## 🔬 已實測抓到的瓶頸（範例）

1. **Prisma tracing 殘留** → wall profile 看到 `readFileSync` 同步讀檔吃 ~38% → 移除 schema 的 `previewFeatures=["tracing"]` 解決。
2. **登入** → wall profile 的 `bcrypt.compare`（`bcryptjs` 純 JS 同步）佔 ~42% → 阻塞 event loop。改善方向：原生 `bcrypt`（走 thread pool）。
3. **傳訊息** → WS fanout `socket.writev`（O(N)）+ 每則訊息 ~3 筆 DB 寫入。改善方向：Redis Pub/Sub 跨實例分攤。

**判讀流程**：metric 發現異常（event loop delay↑ / DB p95↑）→ 框該時段的 Pyroscope wall profile 定位到函式 → 對照程式碼修。

---

## ⚠️ 潛在瓶頸清單（推測，可用上面的訊號驗證）

除了已實測的三項，以下是從程式碼結構推測、值得用觀測去驗證的瓶頸：

| # | 潛在瓶頸 | 為什麼 | 怎麼用觀測驗證 | 改善方向 |
|---|---|---|---|---|
| 1 | **單機 + in-memory presence** | fanout/連線狀態全在一個 Node process 記憶體，Redis Pub/Sub 還沒接 → **單台就是天花板** | 連線/訊息量拉高時 `nodejs_eventloop_delay` 持續惡化、`im_ws_active_connections` 上不去 | 水平擴展 + Redis Pub/Sub 跨實例 fanout |
| 2 | **fanout O(N)，且未抑制 sender echo** | 每則訊息廣播給房間**全部** N 個 socket（含發送者本人）→ 大群組成本 O(N²) | 壓測時 `received ≈ sent × N`（不是 ×(N-1)）；wall profile 的 `socket.writev` 變寬 | 抑制 sender echo；序列化一次重用 buffer；跨實例分攤 |
| 3 | **每則訊息 3 筆 DB 寫入** | `createMessage` = 成員檢查 + insert + 更新房間時間 → 1k msg/s 就是 3k queries/s | `rate(im_db_query_duration_milliseconds_count)` 是訊息率的 ~3 倍；DB p95/p99↑ | 批次寫入（spec 的 Kafka batch-write）、合併查詢 |
| 4 | **4 個獨立 PrismaClient 連線池** | 每個 router/ws 各自 `new PrismaClient()` → 連線池分散、易耗盡 DB max_connections | 高負載下出現查詢逾時錯誤（150 連線那發掉了 69 條）、DB p99 飆 | 合併成共享單例（已規劃，另開 branch） |
| 5 | **bcryptjs 純 JS（登入/註冊）** | 同步雜湊跑在 event loop 上 → 多人同時登入直接卡死 | Phase 1 壓測 wall profile：`bcrypt.compare` 佔 ~42% | 換原生 `bcrypt`（走 thread pool）或調 salt rounds |
| 6 | **無 backpressure / 連線admission 控制** | `ws.send` 沒檢查 `bufferedAmount`；過載時無上限 → 慢客戶端累積 buffer、新連線接不了 | 150 連線那發只連上 81、24% ack、掉 69 條 | 檢查 bufferedAmount、限流、拒絕過載連線 |
| 7 | **fanout 內每 socket 各做一次 `JSON.stringify`** | 同一則訊息序列化 N 次 | wall profile 的 `JSON.stringify` 隨群組大小變寬 | 序列化一次，broadcast 同一份 buffer |
| 8 | **telemetry 自身開銷** | span/metric 記錄、OTLP 匯出、pino transport 都要 CPU | 極限負載下，profile 出現 OTel/pino 相關 stack 變寬 | 高負載時調 tail sampling、降 log level |

> 驗證建議：用 [ws-stress.mjs](../backend/scripts/ws-stress.mjs) 分階段、逐步加大 `USERS`，每一級對照 dashboard 的 `event loop delay`、`DB p95`、`fanout p95`，找出「開始崩」的拐點，再框該時段的 wall profile 定位函式。

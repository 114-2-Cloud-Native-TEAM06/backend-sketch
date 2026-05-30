# Observability 實作計畫（IM 後端）

> IM 後端為 TypeScript / Node.js（純 ESM + tsx，Node 20）的即時通訊系統，
> REST(`:8080`) 與 WebSocket(`:8081`，原生 `ws`) 同一個 process 啟動（`src/index.ts`）。
> 目標：traces、metrics、logs、profiling 四種訊號全收，統一在 Grafana 觀測，並抓出系統瓶頸。
> 部署分兩階段：**階段一本機 Docker**、**階段二 VPS**。
>
> 本文件為定版實作藍圖，已納入針對此 codebase 的修正與技術決定（見「鎖定的決定」）。

---

## 鎖定的決定

| # | 項目 | 採用 | 理由 |
|---|---|---|---|
| 1 | 啟動方式 | 維持 tsx，`tsx --import ./src/instrumentation.ts`，不加 build step | 專案純 ESM、無 `dist/`，dev/prod 都用 tsx |
| 2 | Prisma trace | 納入（階段一就做） | DB 是 spec 點名的瓶頸（1k msg/sec 直寫 PG） |
| 3 | trace_id 注入 log | pino **mixin**（從 active context 撈），不靠 module hook | ESM 下 module patching 最易失效，mixin 與 hook 無關，穩 |
| 4 | log 送進 Loki | **pino-opentelemetry-transport** → OTLP（單一路徑） | 與 traces/metrics 同走 Collector；不 scrape stdout → 不重複 |
| 5 | token 洗除 | 集中 `redactSecrets` + `RedactingSpanProcessor`，套全部含 query 的 attribute | WS 握手 JWT 在 query string，會滲進 span name / 多個 url 屬性 |
| 6 | 連線數 metric | `InMemoryPresenceStore` 維護 O(1) 計數器，observable gauge callback 只同步讀值 | observable gauge 在匯出當下才呼叫 callback，不能 await / 鎖 |
| 7 | 關機收尾 | SIGTERM：`sdk.shutdown()` → `Pyroscope.stop()` → logger flush → exit | 原計畫只 shutdown sdk；tsx watch 重啟需讓 exporter 收尾 |
| 8 | compose 佈署 | 獨立 `observability/docker-compose.yml` + 共用 external network `obs-net` | stack 與 app 解耦；app 已在容器內，須用 service 名互連（非 localhost） |
| 9 | trace→profile | `@pyroscope/otel` 的 span processor | 達成驗收的「延遲→trace→profile」跳轉 |

---

## 1. 架構總覽

```
Node App (IM 後端：REST :8080 + WS :8081，同一 process)
 ├─ OpenTelemetry SDK ──(OTLP/HTTP)──→ OTel Collector ──→ Tempo  (traces)
 │                                                      ├─→ Mimir  (metrics)
 │                                                      └─→ Loki   (logs)
 ├─ pino + pino-opentelemetry-transport ──(OTLP logs)──→ Collector → Loki
 └─ Pyroscope SDK ──────────(直送)─────────────────────→ Pyroscope (profiles)
                                                              ↓
                                                          Grafana (統一視覺化)
```

**關鍵點**：profiling 的資料路徑與其他三種訊號**分開**——Pyroscope SDK 直接送到 Pyroscope server，不經過 OTel Collector。

### 元件選型

| 階段 | 元件 | 負責訊號 |
|------|------|----------|
| Instrument | OpenTelemetry SDK | traces / metrics |
| Instrument | pino + pino-opentelemetry-transport | logs（OTLP，含 trace_id） |
| Instrument | Pyroscope Node SDK | profiling（CPU wall-time / heap） |
| Collect | OpenTelemetry Collector（otel-lgtm 內含） | traces / metrics / logs 統一接收與匯出 |
| Store | Tempo / Mimir / Loki | traces / metrics / logs |
| Store | Pyroscope | profiles |
| Visualize | Grafana | 全部四種訊號統一介面 |

---

## 2. 套件安裝（`backend-sketch/backend/`）

```bash
npm i @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http \
  @opentelemetry/resources @opentelemetry/semantic-conventions @opentelemetry/api \
  @prisma/instrumentation pino pino-opentelemetry-transport \
  @pyroscope/nodejs @pyroscope/otel
```

> 相對初版計畫的差異：
> - **移除** `@opentelemetry/instrumentation-pino`（改用 mixin 注入，避開 ESM hook）。
> - **不裝** `@opentelemetry/sdk-logs` / `@opentelemetry/exporter-logs-otlp-http`（transport 自帶 OTLP export）。
> - **新增** `@prisma/instrumentation`、`pino-opentelemetry-transport`、`@pyroscope/otel`、`@opentelemetry/api`。

---

## 3. 實作階段

### Phase A — `src/instrumentation.ts` + 啟動方式

`instrumentation.ts` 必須在 app 任何其他 import **之前**載入。

內容要點：
- `NodeSDK`：resource(`service.name = im-backend`)、`OTLPTraceExporter`、`PeriodicExportingMetricReader` + `OTLPMetricExporter`（10s）。
- `instrumentations`：`getNodeAutoInstrumentations()`（開 `@opentelemetry/instrumentation-runtime-node` 拿 event loop lag / GC）、**外加 `new PrismaInstrumentation()`**（auto 套件不含 Prisma）。
- **`RedactingSpanProcessor`**：見 §4 安全。
- **`PyroscopeSpanProcessor`**（`@pyroscope/otel`）：讓 span 帶 profile label → trace→profile 跳轉。
- `Pyroscope.init({ serverAddress, appName })` + `Pyroscope.start()`。
- **Graceful shutdown（SIGTERM）**：`await sdk.shutdown()` → `Pyroscope.stop()` → logger transport flush → `process.exit(0)`。
- endpoint 預設值用容器 service 名（見 §5），可被 env 覆寫。
- （選配）以 `PROFILING_ENABLED` env gate Pyroscope，避免 dev 頻繁重啟洗版；預設開啟。

啟動指令（`Dockerfile.dev`，保留 watch）：
```dockerfile
CMD ["npx", "tsx", "watch", "--import", "./src/instrumentation.ts", "src/index.ts"]
```

> **ESM 風險（誠實標記）**：純 ESM 下 OTel 對 `express`/`ws`/`prisma` 的 ESM import 有時要額外 loader hook 才 patch 得到。HTTP/Express 通常 OK；若 WS/Prisma span 沒出現，於 Phase E 補 `@opentelemetry/instrumentation` 的 register hook。logs 路徑（mixin + transport）與 module hook 無關，不受此風險影響。

### Phase B — Prisma tracing

- `prisma/schema.prisma` 的 `generator client` 加上 `previewFeatures = ["tracing"]`。
- 執行 `npx prisma generate`（**不需 migration**，純 client 設定）。
- `instrumentation.ts` 的 instrumentations 已含 `PrismaInstrumentation`。

### Phase C — 應用層埋點（動到的是 active 的 `src/modules/`，非 legacy `src/routes/`）

- 新增 `src/modules/shared/observability/`：
  - `logger.ts`：pino，`mixin()` 從 `trace.getSpan(context.active())` 取 `trace_id`/`span_id`/`trace_flags` 注入每行 log；transport target = `pino-opentelemetry-transport`（OTLP）+ 開發用 stdout。
  - `metrics.ts`：`meter` 與 instruments 定義。
- 把 `console.log/error`（`src/index.ts`、`src/modules/realtime/realtime.server.ts`）改用 pino logger。
- `InMemoryPresenceStore`（`realtime.service.ts`）：加 **O(1) `activeConnections` 計數器**（addClient/removeClient 時 ++/--）+ 同步 getter，供 observable gauge callback 直接讀。
- `realtime.server.ts`：
  - 手動 span `im.message.receive`（包住 `handleSend`），span attribute 帶 `im.room_id` 等（**勿帶 token / body 內容**）。
  - metrics：
    - `im_ws_active_connections`（**ObservableGauge**，callback 同步讀計數器）
    - `im_messages_sent_total`（Counter，事件當下 `.add()`）
    - `im_message_fanout_duration`（Histogram，`.record()`）
    - `im_ws_errors_total`（Counter）
- 跨使用者端到端鏈路（trace context 塞進訊息 payload）→ **階段一不做**，先單機單 span，跑通後再加。

### Phase D — observability compose（獨立 + 共用 network）

```bash
docker network create obs-net   # 一次性
```

- 新增 `observability/docker-compose.yml`：
  - `lgtm`：`grafana/otel-lgtm:latest`，ports `3000`(Grafana)、`4317`(OTLP gRPC)、`4318`(OTLP HTTP)，volume 持久化，join `obs-net`。
  - `pyroscope`：`grafana/pyroscope:latest`，port `4040`，volume，join `obs-net`。
  - `obs-net` 宣告為 `external: true`。
- 改 `backend-sketch/docker-compose.yml`：`app` 服務加入 `obs-net`（external），並設環境變數：
  ```
  OTEL_EXPORTER_OTLP_ENDPOINT=http://lgtm:4318
  PYROSCOPE_SERVER_ADDRESS=http://pyroscope:4040
  OTEL_SERVICE_NAME=im-backend
  ```
- 啟動順序：`docker network create obs-net` → observability compose up → app compose up。
- Grafana `http://localhost:3000`，確認 Tempo / Mimir / Loki / Pyroscope 四源有資料（Pyroscope 若一體鏡像未預設，手動新增資料源指向 `http://pyroscope:4040`）。

### Phase E — 驗收

- [ ] Grafana 看得到 IM 服務 traces（含 WebSocket 訊息鏈路 **與 Prisma SQL span**）
- [ ] Metrics 有 event loop lag / GC / 連線數
- [ ] Logs 能依 trace ID 關聯到對應 trace（mixin 注入生效）
- [ ] Pyroscope 有 CPU 火焰圖與 heap profile
- [ ] 能從延遲圖 → trace → 該時段 profile（trace→profile 關聯，`@pyroscope/otel`）
- [ ] ESM auto-instr 實測：若 WS/Prisma span 缺失，補 OTel ESM loader hook
- [ ] tail sampling / retention：**跑通後再加**（先不過度設定）

---

## 4. 安全 / 隱私：token 洗除

WS 握手的 JWT 走 query string（`?token=<JWT>`），HTTP auto-instrumentation 會把它記進
**span name、`http.url`、`http.target`、`url.query`、`url.full`** 等多處。

作法：集中一個 `redactSecrets(value: string)` util（把 `token=...` 換成 `token=REDACTED`），
透過一個 **`RedactingSpanProcessor`**（`onEnd`）對 span name + 一份 attribute key 清單統一套用，
**不要只綁在 HTTP requestHook 一處**。

> 長遠最佳解是讓 WS 不要把 JWT 放在 query（改 `Sec-WebSocket-Protocol` header 或連線後第一個 frame 認證），
> 屬 app 改動，本次先以洗除處理。

---

## 5. IM 系統重點指標與瓶頸觀測

Node 為單執行緒事件迴圈模型，IM 高併發長連線場景的瓶頸通常**不在 CPU 本身，而在 event loop**。

| 指標 / 訊號 | 來源 | 為什麼重要 |
|------------|------|-----------|
| **Event loop lag** | OTel runtime metrics | Node 最關鍵健康指標；被同步操作塞住則所有連線訊息延遲 |
| **GC / heap** | OTel runtime metrics + Pyroscope heap profile | 長連線累積連線物件易吃記憶體 |
| **CPU 火焰圖** | Pyroscope CPU profile | 抓 JSON 序列化、加解密等卡住 event loop 的同步運算 |
| **連線數 / 重連率 / backpressure** | 自訂 metrics（§Phase C） | IM 健康度核心 |
| **SQL 查詢延遲** | Prisma tracing span | spec 點名的 DB 直寫瓶頸 |
| **訊息端到端延遲** | traces（需帶 trace context 進訊息，階段二）| 發送端到接收端完整鏈路 |

**判讀方式**：先看 event loop lag metric 是否異常 → 若異常，跳到該時段的 Pyroscope CPU profile 看卡在哪個函式。
Node 的瓶頸分析需 metrics + profile 搭配，比單看火焰圖更可靠。

> 注意：Node 無 Go 式的 goroutine / mutex profile，Pyroscope Node SDK 只提供 CPU(wall-time) 與 heap。

---

## 6. 部署：階段二（VPS）

遷移時架構不變，差別在「網路位置」與「安全性」：

1. **App 環境變數指向 VPS 內部位址**：同一 docker network 用 service 名（`http://lgtm:4318`、`http://pyroscope:4040`）；分開部署則用內網 IP，避免走公網。（階段一已用 service 名，遷移時多半不用改。）
2. **observability port 不對外**：Grafana(3000)、OTLP(4317/4318)、Pyroscope(4040) 預設不對外；Grafana UI 經反向代理（Caddy / Nginx）加 TLS + 認證後再對外，其餘僅限內網。
3. **資料持久化與容量**：volume 掛在足夠空間的磁碟；為短期專案設 retention（Tempo / Loki / Mimir），到期自動清除。
4. **資源限制**：給各 container 設 memory limit，避免 observability stack 反過來拖垮被觀測的 IM 服務。

---

## 附註：實作提示

- `instrumentation.ts` 必須最先載入，這是 auto-instrumentation 能否 hook 成功的關鍵。
- 階段一以「能跑、能看到四種訊號」為目標；tail sampling、retention 等跑通後再加。
- profiling 路徑與其他三訊號分開，是最容易設定錯的地方。
- logs 全鏈路（mixin 注入 + transport 送出）零 module-hook 依賴，刻意繞開 ESM 最痛的部分。
- 動到應用程式碼時，改的是 active 的 `src/modules/` 樹，**不是** legacy 的 `src/routes/` / `src/services/`（見 CLAUDE.md）。

---

## 實作狀態（IMPLEMENTED）與對計畫的調整

四個 phase 已實作完成並逐一通過 codex review。實作過程中對原計畫做了以下調整（都有理由）：

| # | 計畫原樣 | 實際做法 | 原因 |
|---|---|---|---|
| 1 | `@pyroscope/otel` span processor | **移除**；trace→profile 改靠 Grafana datasource（otel-lgtm 內建並預設 Pyroscope 資料源 + 時間範圍關聯） | npm 上沒有 `@pyroscope/otel` 這個套件；Node 無 per-span profile label 的成熟支援 |
| 2 | 獨立 `pyroscope` container | **移除**；`grafana/otel-lgtm` 已內建 Pyroscope，改 `PYROSCOPE_SERVER_ADDRESS=http://lgtm:4040` | 分開的 container 會讓 profile 進不到 Grafana 看得到的那個 Pyroscope（codex Phase D） |
| 3 | `@prisma/instrumentation` 任意版 | 釘 **5.22**（對齊 Prisma 5 client） | npm 預設裝 7.x，major 不相容 |
| 4 | `new Resource()` / `SemanticResourceAttributes` | `resourceFromAttributes` + `ATTR_SERVICE_NAME` | OTel 2.x 已移除舊 API |
| 5 | `metricReader` | `metricReaders: [...]`（複數） | 單數已 deprecated（codex Phase A） |
| 6 | logs = mixin + transport（兩件事一個庫） | mixin 注入 + `pino-opentelemetry-transport` 送出，且 `NODE_ENV=test` 時**不開** transport worker | 測試不要 worker thread / 不連不存在的 collector |
| 7 | signal handler 放 instrumentation | **lifecycle 收進 `index.ts`**：關 ws+rest server（先 terminate clients）→ flush telemetry → flush logs → exit，含 10s hard timeout | codex Phase A #1 + Phase C：app 該擁有生命週期；避免關不掉時卡死 |
| 8 | token 洗除（HTTP hook） | `RedactingSpanProcessor` 洗 **attributes + span.name**，regex 含 bare query（`url.query`） | codex Phase A #2/#3：只洗 HTTP hook 會漏 |
| 9 | `npx tsx watch` + `init` | 直接 exec `./node_modules/.bin/tsx`（去掉 npx hop）+ `init: true` | codex Phase D：npx 多一層會吞 SIGTERM |

**已知限制 / 待辦**
- `@pyroscope/nodejs` 的 native binding（`@datadog/pprof`）**只在 Linux container 載入**，Windows host 直跑 app 會 crash → 一律在 Codespaces / Podman / Docker 內跑。
- dev 用 `tsx watch`，SIGTERM → node 的 graceful flush 不是 100% 保證（watcher + tsx→node hop）。正式部署應改用非 watch 的進入點讓 node 直接收訊號。
- **另開 branch**：把 4 個各自的 `new PrismaClient()` 收成共享單例（用現有 `createPrismaClient()`）。與 observability 無關，且此專案目前不是 git repo，需先 `git init`。

---

## Run & Verify（Codespaces 用 docker、本機用 podman；指令同形）

```bash
# 0) 一次性：建共用網路
docker network create obs-net                 # podman network create obs-net

# 1) 起 observability stack
docker compose -f observability/docker-compose.yml up -d

# 2) 起 app stack（在 backend-sketch/ 下）
docker compose up --build -d
docker compose exec app npx prisma migrate dev --name init   # 首次建表
docker compose exec app npx prisma generate                  # 重生帶 tracing 的 client

# 3) 製造流量：register / login → 建 chat → 走 WS 送幾則訊息
# 4) 開 Grafana
#    Codespaces：forwarded port 3000；本機：http://localhost:3000
```

**驗收清單（Phase E）**
- [ ] Tempo 看得到一條 trace 同時含 HTTP server span **與底下的 Prisma SQL span**（這同時驗證 ESM auto-instr 有 hook 到 prisma）
- [ ] Tempo 看得到 WS 的 `im.message.receive` span，且 attribute 內**沒有** token / 訊息內容
- [ ] Mimir 有 `process_runtime_*` event loop lag / GC，及 `im_ws_active_connections`、`im_messages_sent_total`、`im_message_fanout_duration`
- [ ] Loki 的 log 有 `trace_id` 欄位，能跳到對應 trace
- [ ] Pyroscope（lgtm 內建）有 `im-backend` 的 CPU 火焰圖與 heap
- [ ] 延遲圖 → trace → 該時段 profile 跳得通
- [ ] **ESM hook 確認**：若 Prisma SQL span 沒出現，於 `instrumentation.ts` 補 `@opentelemetry/instrumentation` 的 ESM register hook；HTTP/ws 通常自動 OK
- [ ] `docker stop` 後，log 裡看得到 `shutting down` 且最後一批 telemetry 有送出（驗證 graceful flush）

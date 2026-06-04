# 可觀測性系統實作說明（Instrument → Collect → Visualize）

> 即時通訊系統（微服務架構）的端到端可觀測性。目標規模：~10 萬使用者、~1,000 msg/sec。
> 本文件用於簡報產生：每一段都對應一張投影片的素材。

---

## 0. 一句話總覽

我們依照 **OpenTelemetry 標準三階段**建置可觀測性：
**Instrument（埋點）→ Collect（收集）→ Visualize（視覺化）**，
涵蓋 **traces / metrics / logs / profiles 四種訊號**，
橫跨 **5 個微服務**，全部以**服務名稱標籤**區分，
最終匯入 **Grafana Cloud**（永遠在線、免費方案）。

架構流：

```
[5 個微服務]
  user / chat / notification / realtime / message-writer
        │  OpenTelemetry SDK 埋點（自動 + 手動）
        ▼
   OTLP / HTTP (protobuf)  ── Direct 模式，無自架 Collector ──►  Grafana Cloud OTLP Gateway
        │                                                         （+ Pyroscope 專屬 ingest）
        ▼
   Grafana Cloud：Tempo(traces) · Mimir(metrics) · Loki(logs) · Pyroscope(profiles)
        ▼
   一張自製 Dashboard（分服務、可下鑽）
```

---

## 1. Instrument（埋點）

**做法：一份共用的 instrumentation bootstrap，用 `node --import` 預載進「每一個」微服務。**
→ 服務程式碼幾乎不用改，啟動時自動掛上埋點。

### 1-1 自動埋點（Auto-instrumentation）
- `@opentelemetry/auto-instrumentations-node`：自動攔截 **HTTP server/client**，每個 REST 請求自動產生 span + `http_server_duration` 指標。
- `instrumentation-runtime-node`：自動收集 Node.js **runtime 指標** — event loop 延遲、GC、heap 記憶體。

### 1-2 手動埋點（Manual / 自訂業務指標）
在共用套件 `shared-observability/metrics.ts` 定義 IM 專屬指標，於關鍵程式碼點呼叫：

| 指標 | 類型 | 含義 | 埋點位置 |
|---|---|---|---|
| `im_db_query_duration_ms` | Histogram | 每筆 DB 查詢耗時 | Prisma query event（所有服務共用的 DB client） |
| `im_messages_sent_total` | Counter | 成功送出的訊息數 | realtime 送出 ack 時 |
| `im_ws_active_connections` | Gauge | 當前 WebSocket 連線數 | realtime 連線/斷線 |
| `im_message_fanout_duration_ms` | Histogram | 訊息廣播到房間成員的耗時 | realtime fanout |
| `im_ws_errors_total` | Counter（帶 `reason` 標籤） | WS 錯誤數（依原因分類） | realtime 錯誤處理 |

### 1-3 三訊號 + 一剖析
- **Traces**：請求/訊息在跨服務間的完整路徑與耗時（OTLP → Tempo）。
- **Metrics**：上述自動 + 自訂指標（OTLP → Mimir）。
- **Logs**：`pino` 結構化日誌，透過 `pino-opentelemetry-transport` 自動帶上 **trace_id**，可在同一筆 trace 下對齊 log（OTLP → Loki）。
- **Profiles**：`@pyroscope/nodejs` 連續 **wall-clock 效能剖析**，產生火焰圖找熱點函式。

### 1-4 兩個工程亮點（可寫進「為什麼這樣設計」）
- **每服務獨立標籤**：每個服務設 `OTEL_SERVICE_NAME` → 所有數據自帶 `service_name`，因此 dashboard 能「分服務」比較與下鑽。
- **安全性 — Token 脫敏**：自訂 `RedactingSpanProcessor`，在送出前把 URL/屬性中的 JWT token 清掉，避免機敏資料外洩到觀測後端。
- **可一鍵關閉**：`OBSERVABILITY_ENABLED` 總開關，關閉時 app 照常運作、零額外負擔。

---

## 2. Collect（收集）

**我們選擇 Direct 模式 — SDK 直接把 OTLP 送到 Grafana Cloud 的 OTLP Gateway，不自架 Collector。**

| 項目 | 內容 |
|---|---|
| 傳輸協定 | OTLP over HTTP（`http/protobuf`） |
| 目的地 | Grafana Cloud **OTLP Gateway**（由 Grafana 託管，扮演 Collector 角色） |
| 認證 | Basic auth（instance ID + access token），透過 `OTEL_EXPORTER_OTLP_HEADERS` |
| 批次/匯出 | Traces 用 `BatchSpanProcessor`；Metrics 用 `PeriodicExportingMetricReader`（每 60 秒推送） |
| Profiles | 走 Pyroscope 專屬 ingest 端點（與 OTLP 分開） |

**為什麼選 Direct（而非自架 OTel Collector）：**
- ✅ **少一個要自己維運的元件**，架構更簡單、最適合本專案規模。
- ✅ 對應 OpenTelemetry 精神「**one SDK works with any backend**」— 未來要換後端，埋點不用動。
- ⚖️ 代價：少了 Collector 的本地緩衝/轉換彈性 — 但目前規模用不到，需要時可無痛加上。

---

## 3. Visualize（視覺化）

**全部匯入 Grafana Cloud**，四訊號各有對應後端：

| 訊號 | Grafana Cloud 後端 | 看什麼 |
|---|---|---|
| Traces | **Tempo** | 跨服務請求時間軸、瓶頸落在哪一段 |
| Metrics | **Mimir / Prometheus** | 吞吐、延遲、連線數、資源使用 |
| Logs | **Loki** | 結構化日誌，依 trace_id 對齊 |
| Profiles | **Pyroscope** | CPU/wall 火焰圖，定位熱點函式 |

**自製 Dashboard（`im-dashboard.json`）重點：**
- 以 `$service` **模板變數**切換/篩選服務，一張圖看全部或單一服務。
- 分區：**Database**（queries/sec、latency p50/p95/p99、avg by service）、**HTTP server**（req/sec、p95 latency by service）、**Realtime/WebSocket**（active connections、messages/sec、fanout latency、ws errors）。
- 永遠在線、免費方案、團隊多人共用。

---

## 4. 實際數據（壓測/灌流量時的真實截圖數字）

可作為 demo「看得到什麼」的佐證：

- **DB queries/sec**：尖峰衝到 **~120 req/s**，其中 **message-writer 扛 117 req/s** → 驗證非同步寫入架構（訊息經佇列由 writer 批次落地，不直接寫 DB）。
- **DB latency**：p50 ≈ **2 ms**、p95 ≈ **23 ms** → 該負載下 DB 仍健康。
- **DB avg latency by service**：realtime 6.2 ms、chat 5.3 ms、writer 1.4 ms。
- **WebSocket**：active connections = **20**、messages ≈ **20/sec**。
- **HTTP**：各服務 req/sec、p95 latency 分服務呈現。

**一句話價值**：不用看程式碼，光看 dashboard 就能說出「系統正在做什麼、哪個服務在出力」。

---

## 5. 大流量時能看到什麼（這是賣點）

當每秒訊息往**上千**爬時，這套系統即時告訴我們：
- **message-writer 的 DB 寫入率**會不會先頂到天花板 → 是否要加 writer。
- **DB latency p95/p99** 有沒有翹起來 → DB 是否成為瓶頸。
- **realtime 的 event-loop 延遲 / fanout 廣播時間**是否變慢 → 是否要加 realtime 實例。
- **精準定位是哪一個服務**出問題 → 只擴那一個，不用整套加機器。

→ 把「出事才慌張救火」變成「**提前看趨勢、精準擴容、用數據決策**」，大幅縮短故障定位時間（MTTR）。

---

## 6. 部署與可靠性（運維面）

- 全系統部署於 DigitalOcean Droplet，docker-compose 編排，**Caddy 反向代理自動 HTTPS（Let's Encrypt）**，單一網域同源服務前端 + API + WebSocket。
- 觀測資料送至 Grafana Cloud（雲端託管，與應用解耦），**應用掛了也能事後查、團隊隨時可看**。
- realtime 採雙實例 + Redis 跨實例 fanout，可水平擴展。

---

## 7. 投影片切分建議（給生成 AI）

1. **標題 / 總覽**：三階段流程圖（第 0 段）。
2. **Instrument**：自動 + 手動埋點、四訊號、自訂指標表（第 1 段）。
3. **Collect**：Direct 模式、為什麼不自架 Collector（第 2 段）。
4. **Visualize**：Grafana Cloud 四後端 + dashboard（第 3 段）。
5. **實際數據 demo**：截圖 + 關鍵數字（第 4 段）。
6. **大流量價值**：賣點（第 5 段）。
7. **（可選）運維與可靠性**：部署 + HTTPS（第 6 段）。

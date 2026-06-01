# 部署指南（Zeabur）

把 IM 後端部署到 Zeabur，always-on 運行。每一步都列出來，照順序做。

## 架構（要建的服務）

```
[App ×N replicas] ──→ [PostgreSQL]   (訊息 / 使用者持久化)
       │
       └──────────────→ [NATS (JetStream)]   (訊息非同步寫入 + 跨實例 fanout)

Redis：程式碼尚未使用 → 先不部署，等用到再加。
```

App 對外開兩個 port：**8080(REST)** + **8081(WebSocket)**。
NATS / Redis 皆為「設了對應的 *_URL 才啟用」，沒設就走直接寫 DB 模式。

---

## Step 0：前置

- 一個 GitHub repo（已有：`114-2-Cloud-Native-TEAM06/backend-sketch`）。
- 部署用的正式 Dockerfile（已加在 `backend/Dockerfile`）。
- 把 `chore/zeabur-deploy` 合進 **main**（見 Step 1），Zeabur 監看 main。

## Step 1：把部署分支合進 main

開 PR `chore/zeabur-deploy → main` 並合併（PR 連結見本檔結尾說明 / 對話）。
合併後 main 就有 `backend/Dockerfile` + `backend/.dockerignore`，可被 Zeabur build。

> 想先測再合也可以：Zeabur 服務的 branch 先指向 `chore/zeabur-deploy`，測通後再合 main。

## Step 2：Zeabur 專案 + PostgreSQL

1. Zeabur → New Project。
2. Add Service → **Marketplace → PostgreSQL**。
3. 建好後它會提供連線字串（之後給 App 用）。

## Step 3：NATS（JetStream）

1. Add Service → Marketplace 找 **NATS**（若有）；或 Add Service → **Prebuilt / Docker Image** 用 `nats:2.10-alpine`。
2. 自建時 command 設：`-js -sd /data/jetstream -m 8222`，並掛一個 **Volume** 到 `/data`（JetStream 要持久化）。
3. 記下內網位址：`nats://<nats-service-name>.zeabur.internal:4222`。

## Step 4：App 服務

1. Add Service → **Git → 選 repo**，branch 選 **main**。
2. 設定：
   - **Root Directory** = `backend`（會用 `backend/Dockerfile`）
   - Build 方式 = Dockerfile（Zeabur 會自動偵測）
3. 先別急著開外網，先設好環境變數（Step 5）再 deploy。

## Step 5：App 環境變數

```
DATABASE_URL=<Zeabur Postgres 連線字串>
NATS_URL=nats://<nats-service-name>.zeabur.internal:4222
JWT_SECRET=<換成真正的隨機密鑰，勿用 dev 預設>
API_VERSION=1
# REST_PORT=8080 / WS_PORT=8081 用預設即可，可不填
# 不要設 REDIS_URL（程式碼還沒用到）
```

> 服務間用 `.zeabur.internal` 內網 DNS 互連。DATABASE_URL 可用 Zeabur 的變數引用功能綁定 Postgres 服務。

## Step 6：開兩個對外 port

App 服務 → **Networking**：
- 暴露 **8080** → 綁一個網域（REST API）
- 新增暴露 **8081** → 綁另一個網域（WebSocket）

WS client 連 8081 那個網域（`wss://<ws-domain>/ws/chat?token=...`）。

## Step 7：部署 + 驗證

1. Deploy（push main 會自動觸發；首次手動 Deploy）。
2. 看 build/runtime log：
   - 應看到 `prisma migrate deploy` 套用 migration
   - 看到 `REST server running` / `WebSocket server running`
   - `NATS message DB writer started.` / `NATS message status fanout started.`（代表 NATS 接上了）
3. 測：`curl https://<rest-domain>/health` → `{"status":"ok"}`
4. 註冊 / 登入 / 建 chat / WS 送訊息，確認正常。

## Step 8：水平擴展（為 10 萬 DAU）

App 服務 → 設 **replicas ≥ 2**。多實例都連同一個 Postgres + NATS。
- NATS 負責跨實例的訊息 pipeline + status fanout。
- **要驗證**：A 實例的使用者發訊息，連在 B 實例的同房使用者是否即時收到 `msg`
  （目前 `handleSend` 的即時 `msg` 廣播是本機 socket；跨實例靠 `message_status` 事件補，多實例即時性請實測）。

---

## 之後的增量（不阻塞現在部署）

### 加上可觀測性（送 Grafana Cloud）
1. 把 `feat/observability` 合進 main → Zeabur 自動重新部署。
2. App 補環境變數：
   ```
   OTEL_SERVICE_NAME=im-backend
   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<region>.grafana.net/otlp
   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(instanceID:token)>
   OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
   PYROSCOPE_SERVER_ADDRESS=https://profiles-prod-<region>.grafana.net
   PYROSCOPE_BASIC_AUTH_USER=<Pyroscope instance ID>
   PYROSCOPE_BASIC_AUTH_PASSWORD=<含 profiles:write 的 token>
   ```
3. 資料開始持續進 Grafana Cloud（即使你的 localhost 關掉）。
   - 細節見 [observability/QUICKSTART.md](observability/QUICKSTART.md)（在 feat/observability 分支）。

### 加 Redis（等程式碼用到再做）
1. Zeabur 一鍵加 Redis 服務。
2. App 設 `REDIS_URL=redis://<redis-service>.zeabur.internal:6379`。
3. push 自動重新部署。
> 在程式碼真的連 Redis 之前，加它沒有作用，所以不急。

---

## 疑難排解

| 症狀 | 原因 / 解法 |
|---|---|
| build 找不到 `src/` | 確認 Root Directory = `backend`、用的是 `backend/Dockerfile`（非 Dockerfile.dev） |
| 啟動報 `tsx`/`prisma` not found | Dockerfile 用 `npm install --include=dev`（已內建）；確認沒被平台改成 production-only install |
| migrate 失敗 | `DATABASE_URL` 沒設或連不到 Postgres；確認 Postgres 服務已啟動、字串正確 |
| WS 連不上 | 8081 沒在 Networking 暴露；或 client 連到 REST(8080) 網域而非 WS(8081) 網域 |
| 啟動卡住 / NATS 報錯 | `NATS_URL` 指向的服務沒起；先確認 NATS 服務 Running，再重啟 app（或先不設 NATS_URL 走直接寫 DB） |

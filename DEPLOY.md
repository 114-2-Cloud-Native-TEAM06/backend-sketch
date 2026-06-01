# 部署指南 — DigitalOcean App Platform（自動 HTTPS）

把 IM 後端部署到 **DigitalOcean App Platform**，always-on + **自動免費 HTTPS**（老師要求）。
搭配學生 $200 credit，課程期間等於免費。

## 重點：單一 port + 自動 HTTPS

App Platform 一個服務只對外開**一個 HTTP port**，所以這個 repo 已支援**單 port 模式**：
- 設了 `PORT` 環境變數（App Platform 會自動帶）→ app 把 **REST 與 WebSocket 跑在同一個 port**：
  - REST：`https://<app>.ondigitalocean.app/api/v1/...`
  - WS：`wss://<app>.ondigitalocean.app/ws/chat?token=...`（同網域、`/ws/chat` 路徑）
- 沒設 `PORT`（本機 docker-compose / 測試）→ 維持原本兩 port（REST 8080 / WS 8081），不受影響。

> HTTPS / wss 由 App Platform 自動處理，憑證自動續，**不用買網域、不用設憑證**。

## 前端要改的（只有網址，不動邏輯）
```
# 部署後
API base : https://<app>.ondigitalocean.app/api/v1
WS       : wss://<app>.ondigitalocean.app/ws/chat
```
把前端的 API base URL 與 WS URL 兩個值換成上面（`ws://` → `wss://`、去掉 `:8081`）。訊息協定不變。

---

## Step 0：拿額度
辦 [GitHub Student Pack](https://education.github.com/pack)（學校 email / 學生證驗證）→ 領 **DigitalOcean $200 credit**。

## Step 1：把部署分支合進 main
開 PR `chore/zeabur-deploy → main` 合併（含 `backend/Dockerfile`、`.dockerignore`、單 port 改動、本指南）。App Platform 監看 main。
> 想先測再合：App Platform 的 branch 先指 `chore/zeabur-deploy`，測通再合 main。

## Step 2：建 App
1. DigitalOcean → **Create → Apps** → 連 GitHub `114-2-Cloud-Native-TEAM06/backend-sketch`，branch **main**。
2. **Source Directory = `backend`** → 會自動偵測 `backend/Dockerfile`。
3. Resource type 選 **Web Service**。

## Step 3：Web Service 設定
- **HTTP Port = 8080**（App Platform 會把 `PORT` 環境變數設成這個 → app 自動走單 port、REST+WS 都在這）。
  - 保險起見可再手動加環境變數 `PORT=8080`。
- Instance：Basic（最小即可，credit 付）。

## Step 4：加 PostgreSQL
- App 內 **Add Resource → Database → Dev Database (PostgreSQL)**。
- 它會提供連線字串；下一步用變數綁定。

## Step 5：環境變數（Web Service）
```
DATABASE_URL=${db.DATABASE_URL}     # 綁定上面的 DB resource（名稱依你建的為準）
JWT_SECRET=<換成真正的隨機密鑰>
API_VERSION=1
PORT=8080                            # App Platform 通常自動帶；保險可手動設
# 不設 NATS_URL / REDIS_URL（第一階段不啟用，走直接寫 DB）
```

## Step 6：Migrations
`backend/Dockerfile` 的 CMD 開機會先跑 `npx prisma migrate deploy` 再啟動，所以**不用額外設定**。
（也可改用 App Platform 的 **Pre-Deploy Job** 跑 `npx prisma migrate deploy`，多實例時更乾淨。）

## Step 7：部署 + 驗證
1. Create Resources → 等 build & deploy。
2. 看 Runtime Logs：`prisma migrate deploy` 套用、`REST + WebSocket running on port 8080`。
3. `curl https://<app>.ondigitalocean.app/health` → `{"status":"ok"}`（HTTPS 已生效）。
4. 前端把網址換成 Step「前端要改的」那兩個，測 REST + WS。

---

## Phase 2：擴展（為 10 萬 DAU）
- Web Service 調高 **instance count**（水平擴展）。
- **NATS**：App Platform 不適合（服務無持久化 volume，JetStream 會掉資料）。要 NATS 時用：
  - 託管 NATS（Synadia NGS），或
  - 一台小 **Droplet** 跑 NATS（$200 credit 可付），app 設 `NATS_URL` 指過去。

## Phase 3：可觀測性（送 Grafana Cloud）
1. 把 `feat/observability` 合進 main → App Platform 自動重新部署。
2. Web Service 補環境變數：
   ```
   OTEL_SERVICE_NAME=im-backend
   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<region>.grafana.net/otlp
   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(instanceID:token)>
   OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
   PYROSCOPE_SERVER_ADDRESS=https://profiles-prod-<region>.grafana.net
   PYROSCOPE_BASIC_AUTH_USER=<Pyroscope instance ID>
   PYROSCOPE_BASIC_AUTH_PASSWORD=<含 profiles:write 的 token>
   ```
3. 資料持續進 Grafana Cloud（即使本機關掉）。細節見 `observability/QUICKSTART.md`（feat/observability 分支）。

---

## 替代方案（如果改變主意）
- **DO Droplet + docker-compose**：整套（app + Postgres + NATS）免改 code、保留兩 port，但 **HTTPS 要自己用 Caddy + 網域**（Student Pack 有送免費 .me 網域）。適合要 NATS 一起跑。
- **Zeabur**：類似 App Platform，付費（月費 + 用量）。

## 疑難排解
| 症狀 | 解法 |
|---|---|
| WS 連不上 | 確認前端用 `wss://<app>/ws/chat`（同網域、`/ws/chat`、wss）；app log 要顯示 `REST + WebSocket running`（單 port 模式) |
| 還是兩 port / WS 在 8081 | App Platform 沒帶 `PORT` → 手動加環境變數 `PORT=8080` |
| build 找不到 src | Source Directory 設 `backend`、用 `backend/Dockerfile` |
| migrate 失敗 | `DATABASE_URL` 沒綁好或 DB 還沒起 |

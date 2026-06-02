# Instant Messaging System / 謝浩哲

## Background

在企業內部經常會使用通訊軟體進行溝通，討論過程中難免會出現涉及商業機密的內容。如果我們自己設計一套最符合公司規範的通訊軟體，就可以更有效避免機密資訊被外流的情況。請開發一個即時通訊系統，讓每個員工可以透過這套系統進行溝通，讓員工可以根據心地用這套系統進行討論。

## Target Audience

全公司的員工 (粗估 100,000 人)

## System Requirement

- 系統的登入功能使用第三方登入(亦可自行實作登入/註冊系統)
- 使用者可以透過對方的 id 建立跟對方的 1 對 1 聊天室
- 傳送的訊息只需要支援純文字
- 所有的聊天紀錄需要被保存起來，讓使用者可以透過捲動聊天室來查看歷史訊息
- 系統以 Web 的形式呈現
  1. 畫面左側會有聊天室列表，當點擊特定聊天室時，畫面右側會出現該聊天室的內容
  2. 聊天室列表最上方會有一個新增聊天室的按鈕，點下去可以輸入 id，送出後會建立與該使用者的 1 對 1 聊天室

## Advanced Requirement

- 使用者收到某他使用者傳送訊息時，會收到通知
- 支援群組聊天
- 即時顯示使用者上線狀態

## Evaluation Criteria

- **30% 需求轉換與實作**：評估系統功能是否完整實現所有核心與進階需求，使用者介面 (UI) 的易用性與合裝置平台的響應能力 (RWD)。

- **10% 程式碼品質**：實作程式碼的可讀性、規範性、模組化程度、版本控制的有效使用，確保專案中沒有潛在的資安漏洞。

- **25% 架構設計與可擴展性**：面對數萬人同時在線，是否有能力乘載用量，粗估每秒會有 1,000 名使用者送傳送 1 筆訊息。
* 提交 k6 測試報告

- **25% 系統測試與驗證**：檢查是否包含單元測試、整合測試、系統運行正確性。

- **10% 運維與可靠性**：系統部署後，要設置哪些指標監控服務的健康狀態，用量，並釋釋它的意義。

---

## User Plan

### 團隊組成

- 前端 2 人 / 後端 3 人
- 共同技術背景：JavaScript / Node.js / Express.js

### 技術選型

**後端 Stack**

- Runtime：Node.js（事件迴圈架構天生適合大量 WebSocket 長連線，不需為每個連線建立獨立 thread）
- Framework：Express.js（團隊已熟悉，API 需求規模不需 NestJS 的 DI / Module 系統）
- WebSocket：`ws`（原生 WebSocket，不依賴 socket.io 私有 protocol；REST 與 WS 分兩個 port 獨立運行）
- ORM：Prisma（TypeScript-first，schema 定義清晰，migration 管理方便，利於多人協作）
- Database：PostgreSQL（聊天記錄、用戶資料持久化）
- Cache / Pub-Sub：Redis（線上狀態儲存、跨 instance 訊息推播）

> 框架的選擇（Express vs NestJS）不影響 concurrency 能力，Node.js 的 event loop 才是關鍵。Python 雖有 asyncio，但團隊不熟悉，切換只會增加學習成本。

**前端 Stack**

- React 18 + TypeScript 5.4 + Vite 5 + Zustand（客戶端狀態）+ React Router 6
- 原生 WebSocket API（`ws-client.ts` 封裝自動重連、heartbeat、send queue、auth-expiry 處理）

**Port 規劃**

| Port | 用途 |
|---|---|
| 8080 | REST API（Express.js） |
| 8081 | WebSocket（`ws` server） |
| 8082 | user-service REST（預留） |
| 8083 | notification-service REST（預留） |

**本地開發環境（Docker Compose）**

```
services:
  app       # Node.js + Express（REST :8080 + WS :8081）
  postgres  # 資料持久化
  redis     # 快取 & Pub/Sub
```

> Kafka 暫不納入初期 docker-compose。待核心功能穩定後再接入，避免初期 debug 複雜度過高。

### API 規劃

所有路徑加 `/api/v1` 前綴；Auth 統一走 REST，即時訊息走 WebSocket。

**Auth**（`:8080`）

```
POST /api/v1/auth/register   # { email, password, display_name } → { token, user }
POST /api/v1/auth/login      # { email, password } → { token, user }
POST /api/v1/auth/refresh    # Authorization: Bearer <token> → { token }
```

**Users**（`:8080`）

```
GET   /api/v1/users/me       # 我的個人資料
GET   /api/v1/users/:id      # 查詢特定用戶（建立 chat 前確認對方存在）
PATCH /api/v1/users/me       # { display_name?, avatar_url? }
```

**Chats**（`:8080`）

```
GET  /api/v1/chats                    # 我的 chat 列表
POST /api/v1/chats                    # 建立 direct（1-1）或 group chat
GET  /api/v1/chats/:id/members        # chat 成員列表
GET  /api/v1/chats/:id/messages       # 歷史訊息（cursor-based: ?before_message_id=&limit=50）
```

**WebSocket**（`:8081`，連線：`ws://host:8081/ws/chat?token=<JWT>`）

```
# Client → Server（JSON frame）
{ "type": "ping" }
{ "type": "send",   "request_id": "<ULID>", "chat_id": "...", "body": "..." }
{ "type": "typing", "chat_id": "...", "is_typing": true }
{ "type": "ack",    "message_ids": ["..."], "status": "DELIVERED" | "READ" }

# Server → Client（JSON frame）
{ "type": "pong" }
{ "type": "ack",      "request_id": "...", "message_id": "...", "persisted_at": "..." }
{ "type": "msg",      "message": { "id", "chat_id", "sender_id", "body", "created_at" } }
{ "type": "typing",   "chat_id": "...", "user_id": "...", "is_typing": true }
{ "type": "presence", "user_id": "...", "online": true }
{ "type": "error",    "reason": "forbidden" | "rate_limited" | "validation_failed" | "auth_expired" }
```

**Close Code Policy**

| Code | 原因 | 前端行為 |
|---|---|---|
| 1000 | 正常關閉（使用者登出） | 不重連 |
| 1001 | idle_timeout（90s 無訊息） | 自動重連（exponential backoff） |
| 1008 | auth_expired | 清 token，跳回 LoginPage |
| 1011 | internal_error | 自動重連 |

### 開發順序

1. ✅ Auth（`POST /api/v1/auth/register`、`POST /api/v1/auth/login`）+ Prisma schema
2. ✅ WebSocket server（`:8081`）：連線 JWT 驗證、`ping/pong` heartbeat
3. Chat CRUD + 歷史訊息 REST API（`:8080`）
4. WebSocket 訊息收發（`send` → DB 寫入 → `ack` 回傳 + `msg` fanout）
5. Typing 指示、Presence（線上狀態）、已讀回條
6. Redis Pub/Sub 跨 instance 推播、Kafka batch write（高負載）
7. 單元測試 / 整合測試 / k6 壓測報告

### 架構注意事項

- **Auth 方式**：REST 用 `Authorization: Bearer <JWT>`；WebSocket 用 query string `?token=<JWT>`（瀏覽器無法在 WebSocket 握手時設定 header）
- **Idempotency**：每次 `send` frame 和 REST POST 訊息都帶 client 生成的 ULID `request_id`，server 5 分鐘內對相同 `request_id` 不重複寫入
- **ALB Sticky Session**：WebSocket 為狀態性長連線，Load Balancer 必須設定 session affinity，確保同一用戶的連線始終路由到同一個 instance
- **跨 instance 推播**：User A 連在 Instance 1、User B 連在 Instance 2 時，透過 Redis Pub/Sub 讓 Instance 2 收到訊息後推播給 User B
- **DB 寫入壓力**：1k msg/sec 全部直寫 PostgreSQL 有風險，需確認 Connection Pool 配置，或考慮 Kafka Consumer batch write
- **Sender echo 抑制**：`send` 後 server 只回 `ack` 給發送者，`msg` frame 只 fanout 給其他成員，避免重複顯示

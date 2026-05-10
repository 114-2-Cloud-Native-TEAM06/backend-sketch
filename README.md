# Instant Message System Backend

114-2 Cloud Native

## API Usage

### Authentication

```
POST /auth/register
Body: { "username": "alice", "email": "alice@example.com", "password": "secret" }

POST /auth/login
Body: { "email": "alice@example.com", "password": "secret" }
```

Both endpoints return `{ user, token }`. Include the token in subsequent requests:
```
Authorization: Bearer <token>
```

### Users

```
GET /users/me           # current user profile
GET /users/:id          # look up a user before creating a room
```

### Rooms

```
POST /rooms             # create a 1-on-1 or group room
GET  /rooms             # list my rooms (sorted by latest message)
GET  /rooms/:id         # room detail
```

### Messages

```
GET /rooms/:id/messages?cursor=<messageId>&limit=50   # paginated history
```

### WebSocket Events (socket.io)

| Direction | Event | Payload |
|-----------|-------|---------|
| Client → Server | `send_message` | `{ roomId, content }` |
| Client → Server | `join_room` | `{ roomId }` |
| Server → Client | `new_message` | `{ roomId, senderId, content, timestamp }` |
| Server → Client | `user_online` | `{ userId }` |
| Server → Client | `user_offline` | `{ userId }` |
| Server → Client | `notification` | `{ type, payload }` |

---

## Requirements

- Docker & Docker Compose

No other local dependencies are required. Node.js, PostgreSQL, and Redis all run inside containers.

**Start the full stack:**
```bash
docker compose up --build
```

**First-time database setup:**
```bash
docker compose exec app npx prisma migrate dev --name init
```

**Verify it's running:**
```bash
curl http://localhost:8080/health
# → {"status":"ok"}
```

---

## Development

### Start Development Environment

```bash
docker compose up -d
```

### Visualize Database

Open Prisma Studio to view and manage database records:

```bash
docker compose exec app npx prisma studio --hostname 0.0.0.0
```

Then visit `http://localhost:5555` in your browser.

---

## Evaluation Criteria

| Weight | Category | Description |
|--------|----------|-------------|
| 30% | Requirements Implementation | All core and advanced features functional; UI usability and RWD |
| 10% | Code Quality | Readability, modularity, effective version control, no security vulnerabilities |
| 25% | Architecture & Scalability | Capacity for tens of thousands of concurrent users (~1,000 msg/sec); k6 load test report required |
| 25% | Testing & Verification | Unit tests, integration tests, correctness validation |
| 10% | Operations & Reliability | Monitoring metrics, health indicators, and their significance explained |

### Core Requirements

- Login / registration system
- 1-on-1 chat rooms (created by user ID)
- Plain-text messages with full history (scroll to view)
- Web UI: room list on the left, active room on the right
- Add new room button with user ID input

### Advanced Requirements

- Push notifications on incoming messages
- Group chat support
- Real-time online status display

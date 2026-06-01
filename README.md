# Instant Message System Backend

114-2 Cloud Native

## API Usage

### Authentication

```
POST /api/v1/auth/register
Body: { "username": "alice", "email": "alice@example.com", "password": "password123", "display_name": "Alice" }

POST /api/v1/auth/login
Body: { "email": "alice@example.com", "password": "password123" }
```

Both endpoints return `{ user, token }`. Include the token in subsequent requests:
```
Authorization: Bearer <token>
```

### Users

```
GET /api/v1/users/me           # current user profile
GET /api/v1/users/:id          # look up a user before creating a chat
```

### Chats

```
POST /api/v1/chats             # create a 1-on-1 or group chat
GET  /api/v1/chats             # list my chats (sorted by latest message)
GET  /api/v1/chats/:id         # chat detail
```

### Messages

```
GET /api/v1/chats/:id/messages?before_message_id=<messageId>&limit=50   # paginated history
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
docker compose up --build -d
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

### Run Backend Tests

Run all backend tests with Vitest inside Docker. This starts an isolated
PostgreSQL test database, applies Prisma migrations, runs unit and integration
tests, and keeps test data separate from the development database:

```bash
docker compose --profile test run --rm test
```

The `test` service starts `postgres-test`, generates the Prisma client, applies
migrations, and then runs the full test suite.

To run only unit tests in Docker:

```bash
docker compose run --rm test npm run test:unit
```

To generate Vitest coverage reports:

```bash
docker compose run --rm test npm run test:coverage
```

Integration tests require a PostgreSQL test database. To run only integration
tests in Docker:

```bash
docker compose run --rm test sh -c "npx prisma generate && npx prisma migrate deploy && npm run test:integration"
```

If Docker uses a stale backend image after Dockerfile or dependency changes, add
`--build`:

```bash
docker compose run --rm --build test
```

If you run scripts directly outside Docker, `npm run test:unit` does not need a
database, but `npm run test:integration` requires `DATABASE_URL` to point to a
test database whose name or host contains `test`:

```bash
npm run test:unit
NODE_ENV=test DATABASE_URL=postgresql://admin:password@localhost:5432/imdb_test npm run test:integration
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

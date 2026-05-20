# Backend Tests

The backend Vitest suite is intentionally separated by level:

- `services/**/__tests__/*.unit.test.ts` and `packages/**/__tests__/*.unit.test.ts`: fast tests with mocked Prisma clients. These validate route and middleware behavior without a database.
- `tests/integration/`: workflow tests that use a real PostgreSQL test database through Prisma.
- `tests/helpers/`: shared test utilities for HTTP requests and database reset/disconnect logic.

## Running Tests

Run the full backend suite from Docker:

```sh
docker compose --profile test run --rm test
```

The Docker test service generates the Prisma client, applies migrations, and uses an isolated PostgreSQL database (`postgres-test` / `imdb_test`) with `NODE_ENV=test`. Integration tests call `resetDatabase()` before each test and again after the suite finishes. The reset helper refuses to run unless `NODE_ENV=test` and `DATABASE_URL` points to a test database, which prevents accidental cleanup of a development database.

Run only unit tests in Docker:

```sh
docker compose run --rm test npm run test:unit
```

Generate Vitest coverage reports:

```sh
docker compose run --rm test npm run test:coverage
```

Coverage is generated with `@vitest/coverage-v8`:

- Unit coverage reports are written to `coverage/unit`.
- Integration coverage reports are written to `coverage/integration`.
- The reports include statement, line, function, and branch coverage.
- Runtime-only source files are measured; type-only files are excluded from integration coverage.

Run only integration tests in Docker:

```sh
docker compose run --rm test sh -c "npx prisma generate && npx prisma migrate deploy && npm run test:integration"
```

If Docker uses a stale backend image after Dockerfile or dependency changes, add `--build`:

```sh
docker compose run --rm --build test
```

You can also run each level directly from the backend directory. Unit tests do not need a database:

```sh
npm run test:unit
```

Integration tests do need `DATABASE_URL`, and the database name or host must contain `test`:

```sh
NODE_ENV=test DATABASE_URL=postgresql://admin:password@localhost:5432/imdb_test npm run test:integration
```

## Unit Test Coverage

All unit tests are written in AAA style (`Arrange`, `Act`, `Assert`) and cover:

- Happy Path: successful registration, login, protected user lookup, direct chat creation, and message creation.
- Negative Path: missing required fields, invalid password, non-member access, and unsupported update payloads.
- Edge Cases: extreme length usernames, invalid email, null values, special-character group names, self direct chat rejection, empty message body, and message pagination limit capping.
- Security: missing/tampered bearer token rejection, password hashing, duplicate registration conflict without password leakage, and protected routes avoiding persistence calls when unauthenticated.
- Asynchronous: bcrypt password comparison, delayed persistence mocks, and awaited room timestamp updates.

### Auth Routes

File: `services/user-service/src/modules/auth/__tests__/auth.routes.unit.test.ts`

Covered APIs:

- `POST /register`
- `POST /login`
- `POST /refresh`

Covered behavior and boundary conditions:

- Rejects registration when required fields are missing.
- Returns `400 VALIDATION_FAILED` when `username`, `email`, `password`, or `display_name` is absent.
- Does not call `user.create()` when validation fails.
- Rejects invalid username format before querying the database.
- Hashes the password before persistence.
- Returns a user DTO with API field names such as `display_name` and `created_at`.
- Signs a JWT containing `userId` and `username`.
- Returns duplicate-registration conflicts without exposing stored password data.
- Rejects login when the password does not match the stored password hash.
- Returns `401 AUTH_REQUIRED` for invalid login credentials.
- Waits for asynchronous user lookup and password comparison before returning successful login.
- Refreshes a valid bearer token after loading the current persisted user.
- Returns only `{ token }` from refresh.
- Rejects incomplete, missing, tampered, or deleted-user refresh bearer tokens.

### Chat Routes

File: `services/chat-service/src/modules/chats/__tests__/chats.routes.unit.test.ts`

Covered APIs:

- `POST /`
- `GET /:chatId/messages`
- `POST /:chatId/messages`

Covered behavior and boundary conditions:

- Creates a direct chat for the authenticated user and the resolved target user.
- Rejects unauthenticated chat creation before touching persistence.
- Resolves the direct chat target by either `id` or `username`.
- Rejects direct chat creation with the current user.
- Stores both the current user and target user as room members when creating a direct chat.
- Returns the direct chat name from the target user's display name.
- Rejects message reads when the current user is not a member of the room.
- Returns `403 FORBIDDEN` for non-member access.
- Avoids querying messages after membership validation fails.
- Caps message page size at 100 when the request asks for a larger limit.
- Trims message body content before persistence.
- Persists message records with the authenticated sender and target room.
- Updates the room `lastMessageAt` timestamp after a message is created.
- Waits for asynchronous room timestamp updates before returning a message response.
- Returns the message DTO using API fields such as `chat_id`, `sender_id`, `body`, and `created_at`.

### User Routes

File: `services/user-service/src/modules/users/__tests__/users.routes.unit.test.ts`

Covered APIs:

- `GET /me`
- `PATCH /me`

Covered behavior and boundary conditions:

- Loads the current user by the authenticated `userId`.
- Returns the current user DTO with `display_name` and `created_at`.
- Rejects unauthenticated `/me` requests before querying persistence.
- Rejects profile updates when no supported profile fields are provided.
- Returns `400 VALIDATION_FAILED` when neither `display_name` nor `avatar_url` is present.
- Does not call `user.update()` when the update payload has no supported fields.
- Waits for asynchronous profile update persistence before returning the updated DTO.

### Auth Middleware

File: `packages/shared-auth/src/__tests__/auth-middleware.unit.test.ts`

Covered behavior and boundary conditions:

- Rejects requests without a Bearer token.
- Returns `401 AUTH_REQUIRED` for missing or invalid authorization credentials.
- Rejects tampered JWT tokens signed with the wrong secret.
- Verifies a valid JWT using `JWT_SECRET`.
- Attaches the verified JWT payload to `req.user` for downstream handlers.

## Integration Test Coverage

Integration tests use the real Prisma client and a real PostgreSQL database. They are run through `vitest.integration.config.ts`, which disables file parallelism because the tests share one isolated test database and reset it between cases.

All integration tests are written in AAA style (`Arrange`, `Act`, `Assert`) and cover:

- Happy Path: registering, logging in, creating direct/group chats, profile reads/updates, creating messages, typing events, health checks, and listing chats with the latest message.
- Negative Path: duplicate registration, invalid login password, unauthenticated chat creation, non-member message access, and empty message body.
- Edge Cases: special-character display names, long message bodies, duplicate username conflict leaves only one user row, empty/whitespace-only message bodies create no message rows, cursor pagination, and latest-message ordering after writes.
- Security: passwords are stored hashed, invalid login responses do not leak password data, unauthenticated requests create no rooms, non-members cannot read private message content or chat detail, and user lookups do not expose password data.
- Asynchronous: Prisma writes are verified after the HTTP response, room `lastMessageAt` is verified against the persisted message timestamp, chat listing observes the asynchronously persisted latest message, and WebSocket ping/malformed-frame timeout behavior is tested.

### Auth Workflows

File: `tests/integration/auth.integration.test.ts`

Covered workflows:

- Register a new user through `POST /register`.
- Verify the user row is persisted in PostgreSQL.
- Verify the stored password is hashed and does not equal the plain text password.
- Verify the returned JWT is valid and points to the persisted user id.
- Attempt duplicate registration and verify only one matching user remains in PostgreSQL.
- Persist special characters in `display_name` while keeping password hashing intact.
- Register a user, then authenticate the same user through `POST /login`.
- Verify successful login returns the expected user DTO and a token string.
- Refresh a valid JWT through `POST /refresh`.
- Verify the refreshed JWT keeps the persisted user id and username.
- Verify missing, tampered, or deleted-user refresh tokens are rejected.
- Verify invalid login rejects without leaking password details.

### Chat Workflows

File: `tests/integration/chats.integration.test.ts`

Covered workflows:

- Seed two users directly in PostgreSQL.
- Create a direct chat through `POST /`.
- Verify the API response identifies the room as a direct chat and uses the target user's display name.
- Verify `RoomMember` rows are created for both participants.
- Create a group chat and verify `GET /:chatId/members`.
- Verify unauthenticated direct chat creation does not create a room.
- Verify whitespace-only message creation is rejected and creates no message row.
- Verify a non-member cannot read private room messages.
- Verify a non-member cannot access another user's chat detail.
- Seed a user and room directly in PostgreSQL.
- Send a message through `POST /:chatId/messages`.
- Persist long message bodies with special characters without truncation.
- Read older messages using `before_message_id` cursor pagination.
- Accept room-member typing events with a `204` response.
- Verify the message row is persisted with trimmed content, sender id, and room id.
- Verify the room `lastMessageAt` is moved to the created message timestamp.
- Verify chat listing returns the asynchronously persisted latest message.

### User Workflows

File: `tests/integration/users.integration.test.ts`

Covered workflows:

- Return the authenticated user's profile from PostgreSQL.
- Reject unauthenticated profile access.
- Update the authenticated user's display name, including special characters.
- Reject null profile updates without changing the row.
- Return another user by id without exposing password data.
- Return `404 NOT_FOUND` for unknown user ids.

### WebSocket Workflows

File: `tests/integration/ws.integration.test.ts`

Covered workflows:

- Reject missing token connections with close code `1008`.
- Reject tampered token connections.
- Respond asynchronously to `ping` frames with `pong`.
- Ignore malformed frames until timeout while keeping the connection open.

### Service Health Workflows

File: `tests/integration/service-health.integration.test.ts`

Covered workflows:

- Verify `/health` is available through the chat, user, and notification service apps without database access.

## Current Intentional Gaps

The current suite focuses on the backend's core happy paths and the most important validation/auth boundaries. Additional cases worth adding later:

- Login with missing fields or unknown email.
- Integration coverage for invalid chat type, missing members, unknown users, or duplicate direct rooms.
- Full `GET /chats` ordering across multiple rooms and unread-count behavior.
- WebSocket message persistence/broadcast behavior beyond the currently implemented ping/pong protocol.

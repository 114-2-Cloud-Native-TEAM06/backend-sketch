# Backend Tests

This folder owns the backend Vitest suite. Tests are intentionally separated by level:

- `unit/`: fast tests with mocked Prisma clients. These validate route and middleware behavior without a database.
- `integration/`: workflow tests that use a real PostgreSQL test database through Prisma.
- `helpers/`: shared test utilities for HTTP requests and database reset/disconnect logic.

## Running Tests

Run the full backend suite from Docker:

```sh
docker compose run --rm test
```

The Docker test service generates the Prisma client, applies migrations, and uses an isolated PostgreSQL database (`postgres-test` / `imdb_test`) with `NODE_ENV=test`. Integration tests call `resetDatabase()` before each test and again after the suite finishes. The reset helper refuses to run unless `NODE_ENV=test` and `DATABASE_URL` points to a test database, which prevents accidental cleanup of a development database.

Run only unit tests in Docker:

```sh
docker compose run --rm test npm run test:unit
```

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
- Edge Cases: invalid username format, self direct chat rejection, empty message body, and message pagination limit capping.
- Security: missing/tampered bearer token rejection, password hashing, duplicate registration conflict without password leakage, and protected routes avoiding persistence calls when unauthenticated.
- Asynchronous: bcrypt password comparison, delayed persistence mocks, and awaited room timestamp updates.

### Auth Routes

File: `unit/routes/auth.test.ts`

Covered APIs:

- `POST /register`
- `POST /login`

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

### Chat Routes

File: `unit/routes/chats.test.ts`

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

File: `unit/routes/users.test.ts`

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

File: `unit/middleware/auth.test.ts`

Covered behavior and boundary conditions:

- Rejects requests without a Bearer token.
- Returns `401 AUTH_REQUIRED` for missing or invalid authorization credentials.
- Rejects tampered JWT tokens signed with the wrong secret.
- Verifies a valid JWT using `JWT_SECRET`.
- Attaches the verified JWT payload to `req.user` for downstream handlers.

## Integration Test Coverage

Integration tests use the real Prisma client and a real PostgreSQL database. They are run through `vitest.integration.config.ts`, which disables file parallelism because the tests share one isolated test database and reset it between cases.

All integration tests are written in AAA style (`Arrange`, `Act`, `Assert`) and cover:

- Happy Path: registering, logging in, creating direct chats, creating messages, and listing chats with the latest message.
- Negative Path: duplicate registration, invalid login password, unauthenticated chat creation, non-member message access, and empty message body.
- Edge Cases: duplicate username conflict leaves only one user row, empty/whitespace-only message bodies create no message rows, and latest-message ordering is validated after writes.
- Security: passwords are stored hashed, invalid login responses do not leak password data, unauthenticated requests create no rooms, and non-members cannot read private message content.
- Asynchronous: Prisma writes are verified after the HTTP response, room `lastMessageAt` is verified against the persisted message timestamp, and chat listing observes the asynchronously persisted latest message.

### Auth Workflows

File: `integration/auth.integration.test.ts`

Covered workflows:

- Register a new user through `POST /register`.
- Verify the user row is persisted in PostgreSQL.
- Verify the stored password is hashed and does not equal the plain text password.
- Verify the returned JWT is valid and points to the persisted user id.
- Attempt duplicate registration and verify only one matching user remains in PostgreSQL.
- Register a user, then authenticate the same user through `POST /login`.
- Verify successful login returns the expected user DTO and a token string.
- Verify invalid login rejects without leaking password details.

### Chat Workflows

File: `integration/chats.integration.test.ts`

Covered workflows:

- Seed two users directly in PostgreSQL.
- Create a direct chat through `POST /`.
- Verify the API response identifies the room as a direct chat and uses the target user's display name.
- Verify `RoomMember` rows are created for both participants.
- Verify unauthenticated direct chat creation does not create a room.
- Verify whitespace-only message creation is rejected and creates no message row.
- Verify a non-member cannot read private room messages.
- Seed a user and room directly in PostgreSQL.
- Send a message through `POST /:chatId/messages`.
- Verify the message row is persisted with trimmed content, sender id, and room id.
- Verify the room `lastMessageAt` is moved to the created message timestamp.
- Verify chat listing returns the asynchronously persisted latest message.

## Current Intentional Gaps

The current suite focuses on the backend's core happy paths and the most important validation/auth boundaries. Additional cases worth adding later:

- Duplicate registration conflicts for username or email.
- Login with missing fields or unknown email.
- Unauthorized access for all protected chat and user endpoints.
- Chat creation with invalid room type, missing members, unknown users, or duplicate direct rooms.
- Full `GET /chats` ordering across multiple rooms and unread-count behavior.
- `PATCH /me` successful profile update persistence against the real database.

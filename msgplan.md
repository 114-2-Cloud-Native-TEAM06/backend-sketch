# Instant Messaging System Implementation Plan (TDD Edition)

This plan is divided by responsibility. As the Backend Lead, your focus is on the **Backend (BE)** section. The Frontend (FE) section is provided for coordination with your teammate.

---

## 🛠 Backend (BE) - TDD Implementation Route

### 0. Phase 0: Test Infrastructure
*   **Goal**: Enable testing without a real browser.
*   **Tasks**:
    1.  **WS Client Helper**: Create `tests/helpers/ws-client.ts` to programmatically connect to `:8081`, send JSON frames, and await responses.
    2.  **DB Cleaner**: Ensure `beforeEach` in tests resets the `Message` and `Room` tables.

### 1. Phase 1: Message Persistence & Ack (TDD)
*   **RED**: Test sending `{"type": "send", "chat_id": "...", "body": "..."}`. Verify:
    *   DB creates a `Message` record.
    *   Server sends back `{"type": "ack", "request_id": "...", ...}`.
*   **GREEN**: Implement basic `send` logic in `backend/src/index.ts`.
*   **REFACTOR**: Extract logic to `src/services/messageService.ts`. Handle membership validation (ensure user is in the room).

### 2. Phase 2: High-Performance Broadcast (TDD)
*   **RED**: Test with two WS clients. Client A sends; Client B (in same room) receives `{"type": "msg", ...}`. Client C (different room) receives nothing.
*   **GREEN**: Implement `Map<roomId, Set<WebSocket>>` indexing.
    *   Update index on `connection` and `close`.
*   **REFACTOR**: Graceful handling of partial failures (e.g., one client socket hanging).

### 3. Phase 3: Advanced Presence & Typing (TDD)
*   **RED/GREEN**: Test that `presence: online` is broadcast to all contacts when a user connects.
*   **RED/GREEN**: Test that `typing: true` frames are relayed to room members.

### 4. Phase 4: Scalability & Microservice Transition
*   **Redis Integration**: Replace local `Map` with Redis Pub/Sub.
*   **Performance**: Use k6 to verify 1,000 msg/sec.
*   **Verification**: All Phase 1-3 tests must still pass with Redis enabled.

---

## 🎨 Frontend (FE) - Implementation Route (For Team Coordination)

*Users of this plan should hand this section to the FE Developer.*

### 1. Phase 1: UI & Optimistic Flow
*   **Task**: Implement `useChat.ts` to generate `request_id` (ULID) and push to UI immediately.
*   **TDD**: Verify Zustand store updates status from `sending` to `sent` upon receiving `ack`.

### 2. Phase 2: Real-time Updates
*   **Task**: Implement `useChatChannel.ts` to listen for incoming `msg` frames and append to state.

### 3. Phase 3: Presence UI
*   **Task**: Display "Online" status dots and "User is typing..." indicators.

---

## 🤝 Coordination Checklist (BE/FE Contract)
1.  **JWT**: FE must send token via query string: `ws://.../ws/chat?token=<JWT>`.
2.  **Frame Format**: All frames MUST be JSON with a `type` field.
3.  **Idempotency**: BE will use `request_id` to prevent double-processing.
4.  **Error Codes**: BE uses Standard WebSocket Close Codes (e.g., `1008` for Auth Expired).

## ✅ BE Verification Checklist
- [ ] Every API/WS event has a failing integration test in `tests/integration/`.
- [ ] No `for` loops over all connections (must use Indexing or Pub/Sub).
- [ ] Database updates for `lastMessageAt` are verified in tests.
- [ ] Redis is only introduced after local logic is verified by tests.

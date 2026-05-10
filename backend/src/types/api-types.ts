/**
 * Canonical wire types — mirrors docs/api-contracts.md.
 *
 * SOURCE OF TRUTH for the JSON shapes flowing between:
 *   - Frontend (M1)  ↔  Edge / WS (M2)         — see WsFrame*
 *   - Frontend (M1)  ↔  chat-service REST (M3) — see Chat / Message
 *   - Frontend (M1)  ↔  user-service REST (M4) — see User / AuthResponse
 *   - Frontend (M1)  ↔  notification-service (M4) — see NotificationPreferences
 *
 * Java DTOs (presentation/dto/*.java) MUST mirror these names exactly.
 * Any change here is a breaking contract change — open a PR pinging the
 * matching backend owner per .github/CODEOWNERS.
 */

// ─── Domain primitives ───────────────────────────────────────────────────

export type Ulid     = string;
export type Iso8601  = string;
export type UserId   = string;
export type ChatId   = string;
export type MessageId = string;

// ─── Core entities (REST + WS payloads) ─────────────────────────────────

export type MessageType = "TEXT" | "IMAGE" | "FILE" | "SYSTEM";

export interface Message {
  id:         MessageId;
  chat_id:    ChatId;
  sender_id:  UserId;
  type:       MessageType;
  body:       string;
  created_at: Iso8601;
}

export interface Chat {
  id:            ChatId;
  type:          "direct" | "group";
  name:          string;
  avatar_url?:   string;
  last_message?: Message;
  unread_count:  number;
}

export interface User {
  id:           UserId;
  username:     string;   // unique login identifier
  email:        string;
  display_name: string;
  avatar_url?:  string;
  created_at:   Iso8601;
}

// ─── REST request bodies ────────────────────────────────────────────────

export interface SendMessageRequest {
  request_id: Ulid;
  type:       Exclude<MessageType, "SYSTEM">;
  body:       string;
}

export interface RegisterRequest {
  username:     string;
  email:        string;
  password:     string;
  display_name: string;
}

export interface LoginRequest {
  email:    string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user:  User;
}

export interface UpdateProfileRequest {
  display_name?: string;
  avatar_url?:   string;
}

export interface CreateChatRequest {
  type:       "direct" | "group";
  name?:      string;
  member_ids: UserId[];
}

export interface RegisterDeviceRequest {
  token:    string;
  platform: "FCM" | "APNS";
}

export interface NotificationPreferences {
  user_id:           UserId;
  push_enabled:      boolean;
  email_enabled:     boolean;
  mentions_only:     boolean;
  quiet_hours_tz:    string;     // e.g. "Asia/Taipei"
  quiet_hours_start: number;     // 0–23
  quiet_hours_end:   number;
}

// ─── WebSocket frames ───────────────────────────────────────────────────

export type WsClientFrame =
  | { type: "send";    request_id: Ulid; chat_id: ChatId; body: string; msg_type?: Exclude<MessageType, "SYSTEM"> }
  | { type: "typing";  chat_id: ChatId; is_typing: boolean }
  | { type: "ack";     message_ids: MessageId[]; status: "DELIVERED" | "READ" }
  | { type: "ping" };

export type WsServerFrame =
  | { type: "ack";      request_id: Ulid; message_id: MessageId; persisted_at: Iso8601 }
  | { type: "msg";      message: Message }
  | { type: "typing";   chat_id: ChatId; user_id: UserId; is_typing: boolean }
  | { type: "presence"; user_id: UserId; online: boolean }
  | { type: "error";    reason: WsErrorReason; detail?: string }
  | { type: "pong" };

export type WsErrorReason =
  | "unknown_op"
  | "rate_limited"
  | "forbidden"
  | "validation_failed"
  | "auth_expired";

// Re-exported alias for ergonomic imports in hooks/components.
export type WsFrame = WsClientFrame | WsServerFrame;

// ─── Error envelope (REST + gRPC) ───────────────────────────────────────

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL";

export interface ApiError {
  error: {
    code:    ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

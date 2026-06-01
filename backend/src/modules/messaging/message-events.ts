export const CHAT_MESSAGES_STREAM = 'CHAT_MESSAGES';
export const CHAT_MESSAGE_STATUS_STREAM = 'CHAT_MESSAGE_STATUS';

export const MESSAGE_ACCEPTED_SUBJECT = 'chat.message.accepted';
export const MESSAGE_PERSISTED_SUBJECT = 'chat.message.persisted';
export const MESSAGE_FAILED_SUBJECT = 'chat.message.failed';

export interface ChatMessageAcceptedEvent {
  event_version: 1;
  message_id: string;
  request_id: string;
  room_id: string;
  sender_id: string;
  body: string;
  accepted_at: string;
}

export interface ChatMessagePersistedEvent {
  event_version: 1;
  message_id: string;
  request_id: string;
  room_id: string;
  sender_id: string;
  persisted_at: string;
}

export interface ChatMessageFailedEvent {
  event_version: 1;
  message_id: string;
  request_id: string;
  room_id: string;
  sender_id: string;
  reason: string;
}


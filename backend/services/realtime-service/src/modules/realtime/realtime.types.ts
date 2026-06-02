import type { WebSocket } from 'ws';
import type { WsServerFrame } from '../../../../../packages/shared-types/src/api-types.js';

export interface JwtPayload {
  userId: string;
  username: string;
}

export interface ClientState {
  ws: WebSocket;
  user: JwtPayload;
  roomIds: Set<string>;
  connectionId: string;
}

export interface PresenceStore {
  addClient(state: ClientState): void;
  removeClient(ws: WebSocket): ClientState | undefined;
  getClientState(ws: WebSocket): ClientState | undefined;
  getRoomSockets(roomId: string): Iterable<WebSocket> | undefined;
  addSocketToRoom(state: ClientState, roomId: string): void;
  removeSocketFromRooms(state: ClientState): void;
  hasOpenSocketForUser(userId: string): boolean;
  broadcastToRoom(roomId: string, frame: WsServerFrame): void;
}

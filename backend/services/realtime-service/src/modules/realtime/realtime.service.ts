import { WebSocket } from 'ws';
import type { WsServerFrame } from '../../../../../packages/shared-types/src/api-types.js';
import type { ClientState, PresenceStore } from './realtime.types.js';

export class InMemoryPresenceStore implements PresenceStore {
  private readonly roomSockets = new Map<string, Set<WebSocket>>();
  private readonly userSockets = new Map<string, Set<WebSocket>>();
  private readonly clientStates = new Map<WebSocket, ClientState>();
  private readonly sendBufferLimitBytes = Number(process.env.WS_SEND_BUFFER_LIMIT_BYTES || 1024 * 1024);

  addClient(state: ClientState): void {
    this.clientStates.set(state.ws, state);

    const sockets = this.userSockets.get(state.user.userId) ?? new Set<WebSocket>();
    sockets.add(state.ws);
    this.userSockets.set(state.user.userId, sockets);
  }

  removeClient(ws: WebSocket): ClientState | undefined {
    const state = this.clientStates.get(ws);
    if (!state) return undefined;

    this.removeSocketFromRooms(state);
    const sockets = this.userSockets.get(state.user.userId);
    if (sockets) {
      sockets.delete(ws);
      if (!sockets.size) this.userSockets.delete(state.user.userId);
    }
    this.clientStates.delete(ws);
    return state;
  }

  getClientState(ws: WebSocket): ClientState | undefined {
    return this.clientStates.get(ws);
  }

  getUserSockets(userId: string): Iterable<WebSocket> | undefined {
    return this.userSockets.get(userId);
  }

  getRoomSockets(roomId: string): Iterable<WebSocket> | undefined {
    return this.roomSockets.get(roomId);
  }

  addSocketToRoom(state: ClientState, roomId: string): void {
    state.roomIds.add(roomId);
    const sockets = this.roomSockets.get(roomId) ?? new Set<WebSocket>();
    sockets.add(state.ws);
    this.roomSockets.set(roomId, sockets);
  }

  removeSocketFromRooms(state: ClientState): void {
    for (const roomId of state.roomIds) {
      const sockets = this.roomSockets.get(roomId);
      if (!sockets) continue;
      sockets.delete(state.ws);
      if (!sockets.size) this.roomSockets.delete(roomId);
    }
  }

  hasOpenSocketForUser(userId: string): boolean {
    const sockets = this.userSockets.get(userId);
    if (!sockets) return false;

    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  broadcastToUser(userId: string, frame: WsServerFrame): void {
    const sockets = this.userSockets.get(userId);
    if (!sockets) return;
    for (const ws of sockets) this.sendJson(ws, frame);
  }

  broadcastToRoom(roomId: string, frame: WsServerFrame): void {
    const sockets = this.roomSockets.get(roomId);
    if (!sockets) return;
    for (const ws of sockets) this.sendJson(ws, frame);
  }

  private sendJson(ws: WebSocket, frame: WsServerFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > this.sendBufferLimitBytes) {
      ws.close(1013, 'backpressure');
      return;
    }
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // Close cleanup removes dead sockets.
    }
  }
}

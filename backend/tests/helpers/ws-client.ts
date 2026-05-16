import { once } from 'events';
import WebSocket from 'ws';

export function connectWs(port: number, query: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/chat?${query}`);
}

export async function openWs(port: number, query: string): Promise<WebSocket> {
  const ws = connectWs(port, query);
  await once(ws, 'open');
  return ws;
}

export function sendJson(ws: WebSocket, frame: unknown): void {
  ws.send(JSON.stringify(frame));
}

export async function waitForJsonMessage<T>(ws: WebSocket, label?: string, timeoutMs = 250): Promise<T> {
  return waitForJsonFrame<T>(ws, () => true, label, timeoutMs);
}

export async function waitForJsonFrame<T>(
  ws: WebSocket,
  predicate: (frame: T) => boolean,
  label?: string,
  timeoutMs = 250,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const receivedFrames: unknown[] = [];
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      const framesSummary = receivedFrames.slice(-5).map((f) => JSON.stringify(f)).join('\n  ');
      const msg = `Timed out waiting for WebSocket message${label ? ` (${label})` : ''}`;
      const detail = receivedFrames.length > 0 ? `\nLast received frames:\n  ${framesSummary}` : '\nNo frames received';
      reject(new Error(`${msg}${detail}`));
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData): void => {
      const frame = JSON.parse(data.toString()) as T;
      receivedFrames.push(frame);
      if (!predicate(frame)) return;

      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(frame);
    };

    ws.on('message', onMessage);
  });
}

export async function expectNoMessage(ws: WebSocket, timeoutMs = 50): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timeout);
      reject(new Error(`Unexpected WebSocket message: ${data.toString()}`));
    });
  });
}

import { fileURLToPath } from 'url';
import { createPrismaClient } from '../../../packages/shared-db/src/prisma.js';
import { startWebSocketServer } from './modules/realtime/realtime.server.js';

export function startRealtimeService(): ReturnType<typeof startWebSocketServer> {
  return startWebSocketServer(Number(process.env.WS_PORT || 8081), createPrismaClient());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startRealtimeService();
}

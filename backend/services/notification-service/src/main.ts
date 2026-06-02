import { createServer, Server } from 'http';
import { fileURLToPath } from 'url';
import { createNotificationServiceApp } from './app.js';

export function startNotificationService(
  port = Number(process.env.NOTIFICATION_SERVICE_PORT || 8083),
): Server {
  const server = createServer(createNotificationServiceApp());
  server.listen(port, () => {
    console.log(`notification-service running on port ${port}`);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startNotificationService();
}

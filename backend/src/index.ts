import express, { Express } from 'express';
import { createServer, Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import authRoutes from './routes/auth.js';

const app: Express = express();
const httpServer: HttpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

app.use(express.json());

const API_VERSION = process.env.API_VERSION || '1';
app.use(`/api/v${API_VERSION}/auth`, authRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

io.on('connection', (socket) => {
  console.log('user connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('user disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

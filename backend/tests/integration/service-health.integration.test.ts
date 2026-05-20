import { expect, test } from 'vitest';
import { createChatServiceApp } from '../../services/chat-service/src/app.js';
import { createNotificationServiceApp } from '../../services/notification-service/src/app.js';
import { createUserServiceApp } from '../../services/user-service/src/app.js';
import { requestJson } from '../helpers/request-json.js';

test('chat service exposes health endpoint without database access', async () => {
  // Arrange
  const app = createChatServiceApp();

  // Act
  const res = await requestJson(app, '/health');

  // Assert
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok' });
});

test('user service exposes health endpoint without database access', async () => {
  // Arrange
  const app = createUserServiceApp();

  // Act
  const res = await requestJson(app, '/health');

  // Assert
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok' });
});

test('notification service exposes health endpoint without database access', async () => {
  // Arrange
  const app = createNotificationServiceApp();

  // Act
  const res = await requestJson(app, '/health');

  // Assert
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok' });
});

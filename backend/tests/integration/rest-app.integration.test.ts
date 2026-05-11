import { expect, test } from 'vitest';
import { createRestApp } from '../../src/index.js';
import { requestJson } from '../helpers/request-json.js';

test('rest app exposes health endpoint without database access', async () => {
  // Arrange
  const app = createRestApp();

  // Act
  const res = await requestJson(app as never, '/health');

  // Assert
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok' });
});

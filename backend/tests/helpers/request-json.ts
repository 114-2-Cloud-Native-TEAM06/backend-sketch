import express, { Router } from 'express';
import { Server } from 'http';

export interface TestResponse<T = unknown> {
  status: number;
  body: T;
}

export async function requestJson<T = unknown>(
  router: Router,
  path: string,
  init: RequestInit = {},
): Promise<TestResponse<T>> {
  const app = express();
  app.use(express.json());
  app.use(router);

  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to allocate test server port');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    const body = text ? JSON.parse(text) as T : undefined as T;

    return { status: response.status, body };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

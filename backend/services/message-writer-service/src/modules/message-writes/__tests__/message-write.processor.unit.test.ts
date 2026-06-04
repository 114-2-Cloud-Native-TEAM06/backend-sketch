import { describe, expect, test, vi } from 'vitest';
import { processMessageWriteCommand, processMessageWriteCommands } from '../message-write.processor.js';
import type { PrismaClient } from '@prisma/client';

describe('message-write.processor.ts unit tests', () => {
  test('processMessageWriteCommand throws error on failure if deliveryAttempt < maxDeliveryAttempts', async () => {
    const prismaMock = {
      $transaction: vi.fn().mockRejectedValue(new Error('DB connection error')),
    } as unknown as PrismaClient;

    const command = {
      message_id: 'msg-1',
      request_id: 'req-1',
      sender_id: 'sender-1',
      room_id: 'room-1',
      body: 'hello',
      accepted_at: new Date().toISOString(),
    };

    await expect(processMessageWriteCommand(prismaMock, command, { deliveryAttempt: 1, maxDeliveryAttempts: 3 }))
      .rejects.toThrowError('DB connection error');
  });

  test('processMessageWriteCommand dead-letters message and returns undefined if deliveryAttempt >= maxDeliveryAttempts', async () => {
    const prismaMock = {
      $transaction: vi.fn().mockRejectedValue(new Error('Constraint failure')),
      messageWrite: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaClient;

    const command = {
      message_id: 'msg-1',
      request_id: 'req-1',
      sender_id: 'sender-1',
      room_id: 'room-1',
      body: 'hello',
      accepted_at: new Date().toISOString(),
    };

    const result = await processMessageWriteCommand(prismaMock, command, { deliveryAttempt: 3, maxDeliveryAttempts: 3 });
    expect(result).toBeUndefined();
    expect(prismaMock.messageWrite.create).toHaveBeenCalled();
  });

  test('processMessageWriteCommands throws error if batch contains conflicting message write commands', async () => {
    const prismaMock = {} as unknown as PrismaClient;
    const commands = [
      {
        message_id: 'msg-1',
        request_id: 'req-1',
        sender_id: 'sender-1',
        room_id: 'room-1',
        body: 'hello',
        accepted_at: new Date().toISOString(),
      },
      {
        message_id: 'msg-2',
        request_id: 'req-1',
        sender_id: 'sender-1',
        room_id: 'room-1',
        body: 'world',
        accepted_at: new Date().toISOString(),
      },
    ];

    await expect(processMessageWriteCommands(prismaMock, commands))
      .rejects.toThrowError('batch contains conflicting message write commands');
  });
});

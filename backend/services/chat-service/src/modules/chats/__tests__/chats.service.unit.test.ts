import { describe, expect, test, vi } from 'vitest';
import { createChat } from '../chats.service.js';
import { AppError } from '../../../../../../packages/shared-errors/src/app-error.js';

vi.mock('../chats.repository.js', () => {
  return {
    findUserForChatMember: vi.fn(),
    findDirectRoomCandidates: vi.fn(),
    createDirectRoom: vi.fn(),
    createGroupRoom: vi.fn(),
    findPendingMessageWritesForRooms: vi.fn(),
    findMembershipsForUser: vi.fn(),
  };
});

import { findUserForChatMember } from '../chats.repository.js';

describe('chats.service.ts unit tests', () => {
  test('createChat validation - type and member_ids are required', async () => {
    await expect(createChat({} as any, 'user-1', { type: '', member_ids: [] } as any))
      .rejects.toThrowError(new AppError(400, 'VALIDATION_FAILED', 'type and member_ids are required'));
  });

  test('createChat validation - direct chat requires exactly 1 member_id', async () => {
    await expect(createChat({} as any, 'user-1', { type: 'direct', member_ids: [] } as any))
      .rejects.toThrowError(new AppError(400, 'VALIDATION_FAILED', 'direct chat requires exactly 1 member_id'));
  });

  test('createChat validation - cannot create a direct chat with yourself', async () => {
    vi.mocked(findUserForChatMember).mockResolvedValue({ id: 'user-1', displayName: 'Alice' } as any);
    await expect(createChat({} as any, 'user-1', { type: 'direct', member_ids: ['user-1'] } as any))
      .rejects.toThrowError(new AppError(400, 'VALIDATION_FAILED', 'cannot create a direct chat with yourself'));
  });

  test('createChat validation - target user not found', async () => {
    vi.mocked(findUserForChatMember).mockResolvedValue(null);
    await expect(createChat({} as any, 'user-1', { type: 'direct', member_ids: ['user-2'] } as any))
      .rejects.toThrowError(new AppError(422, 'VALIDATION_FAILED', 'member_ids[0]: user "user-2" not found'));
  });
});

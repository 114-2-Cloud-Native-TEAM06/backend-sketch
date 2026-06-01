import type { Iso8601 } from '../../shared-types/src/api-types.js';

export interface MessageWriteCommand {
  message_id: string;
  request_id: string;
  sender_id: string;
  room_id: string;
  body: string;
  accepted_at: Iso8601;
  origin_connection_id?: string;
}

export interface MessageWritePublisher {
  publishMessageWrite(command: MessageWriteCommand): Promise<void>;
}

export class InMemoryMessageWriteBuffer implements MessageWritePublisher {
  readonly commands: MessageWriteCommand[] = [];

  constructor(private readonly onPublish?: (command: MessageWriteCommand) => Promise<void> | void) {}

  async publishMessageWrite(command: MessageWriteCommand): Promise<void> {
    this.commands.push(command);
    await this.onPublish?.(command);
  }
}

export async function publishMessageWriteWithRetry(
  publisher: MessageWritePublisher,
  command: MessageWriteCommand,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = Math.max(0, options.delayMs ?? 25);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await publisher.publishMessageWrite(command);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

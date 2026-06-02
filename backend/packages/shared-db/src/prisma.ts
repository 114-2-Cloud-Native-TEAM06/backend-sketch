import { PrismaClient, type Prisma } from '@prisma/client';
import { dbQueryDuration } from '../../shared-observability/src/metrics.js';
import { logger } from '../../shared-observability/src/logger.js';

const SLOW_QUERY_MS = (() => {
  const parsed = Number(process.env.DB_SLOW_QUERY_MS);
  return Number.isFinite(parsed) ? parsed : 100;
})();

/**
 * Shared PrismaClient factory used by every service. Instrumented via Prisma's
 * own `query` event (the Prisma OTel auto-instrumentation is incompatible with
 * OTel SDK 2.x): each query records into im_db_query_duration_ms and slow
 * queries are logged. Because all services build their client here, they all
 * get DB observability for free.
 */
export function createPrismaClient(): PrismaClient {
  const prisma = new PrismaClient({
    log: [{ emit: 'event', level: 'query' }],
  });

  prisma.$on('query', (event: Prisma.QueryEvent) => {
    dbQueryDuration.record(event.duration);
    if (event.duration >= SLOW_QUERY_MS) {
      // params intentionally omitted — they can contain credentials / PII.
      logger.warn({ duration_ms: event.duration, query: event.query }, 'slow db query');
    }
  });

  return prisma;
}

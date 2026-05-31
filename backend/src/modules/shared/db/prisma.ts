import { PrismaClient, type Prisma } from '@prisma/client';
import { dbQueryDuration } from '../observability/metrics.js';
import { logger } from '../observability/logger.js';

const parsedSlowMs = Number(process.env.DB_SLOW_QUERY_MS);
const SLOW_QUERY_MS = Number.isFinite(parsedSlowMs) ? parsedSlowMs : 100;

/**
 * Creates a PrismaClient instrumented for observability via Prisma's own
 * `query` event (the Prisma OTel auto-instrumentation is incompatible with the
 * OTel SDK 2.x this app uses). Each query records into the im_db_query_duration
 * histogram; slow queries are logged.
 */
export function createPrismaClient(): PrismaClient {
  const prisma = new PrismaClient({
    log: [{ emit: 'event', level: 'query' }],
  });

  prisma.$on('query', (event: Prisma.QueryEvent) => {
    dbQueryDuration.record(event.duration);
    if (event.duration >= SLOW_QUERY_MS) {
      // params are intentionally omitted — they can contain credentials / PII.
      logger.warn({ duration_ms: event.duration, query: event.query }, 'slow db query');
    }
  });

  return prisma;
}

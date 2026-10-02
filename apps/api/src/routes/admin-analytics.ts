import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import {
  AnalyticsQueryError,
  exportAnalyticsEventsCsv,
  parseAnalyticsWindow,
  readAnalyticsFunnels,
} from '../services/analytics-funnels.js';

/**
 * Admin analytics (PR 3): the four commercial funnels and a bounded export.
 *
 * Read with `analytics.read`, export with `analytics.export` -- the analyst
 * and administrator roles. GET only: nothing here changes anything, and no
 * route returns an email or anything else joined from an account.
 */
export default async function adminAnalyticsRoutes(app: FastifyInstance, opts: { db: Db; analyticsEnabled: boolean }) {
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/admin/analytics/funnels',
    { preHandler: app.requirePermission('analytics.read') },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      try {
        return await readAnalyticsFunnels(opts.db, parseAnalyticsWindow(request.query), opts.analyticsEnabled);
      } catch (error) {
        if (error instanceof AnalyticsQueryError) return reply.code(400).send({ error: 'invalid_query', message: error.message });
        throw error;
      }
    },
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/admin/analytics/events/export.csv',
    { preHandler: app.requirePermission('analytics.export') },
    async (request, reply) => {
      let window;
      try {
        window = parseAnalyticsWindow(request.query);
      } catch (error) {
        if (error instanceof AnalyticsQueryError) return reply.code(400).send({ error: 'invalid_query', message: error.message });
        throw error;
      }
      const { csv, truncated } = await exportAnalyticsEventsCsv(opts.db, window);
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="over18-analytics-events.csv"');
      reply.header('cache-control', 'private, no-store');
      // Bounded: say so rather than let a cut-off export pass for a whole one.
      reply.header('x-export-truncated', truncated ? 'true' : 'false');
      return reply.send(csv);
    },
  );
}

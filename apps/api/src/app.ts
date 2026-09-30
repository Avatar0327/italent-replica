import type { Db } from '@italent/db';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { AppError, errorResponse, handleError } from './errors.js';
import { limitBody, requireJson } from './middleware.js';

export interface AppDeps {
  /** 不传则 /healthz 只报告进程存活，不探测数据库。 */
  readonly db?: Db;
}

export function createApp(deps: AppDeps = {}): Hono {
  const app = new Hono();

  app.use('*', requireJson);
  app.use('*', limitBody());

  app.get('/healthz', async (c) => {
    if (deps.db) {
      try {
        await deps.db.execute(sql`SELECT 1`);
      } catch {
        throw new AppError('SERVICE_UNAVAILABLE', '数据库不可用');
      }
    }
    return c.json({ status: 'ok' as const });
  });

  app.notFound((c) => errorResponse(c, 'NOT_FOUND', '接口不存在'));
  app.onError(handleError);
  return app;
}

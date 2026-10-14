/** DEC-453④：只接受 asOf；根与显示筛选完全复用 C1 保存条件。 */
import { withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { validIsoDate } from '../org/read-model.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { SUCCESSION_BASE, successionContext } from './access.js';
import { readPositionMap } from './position-map.js';

export function registerPositionMapRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${SUCCESSION_BASE}/maps/position`, async (c) => {
    const ctx = await successionContext(c, deps, 'map');
    if (Object.entries(c.req.queries()).some(([key, values]) => key !== 'asOf' || values.length !== 1))
      throw new AppError('VALIDATION_FAILED', '职位地图只接受单个 asOf');
    const today = tenantLocalDate(deps.clock(), ctx.timezone);
    const asOf = c.req.query('asOf') ?? today;
    if (!validIsoDate(asOf)) throw new AppError('VALIDATION_FAILED', '查询时点必须为合法日期');
    if (asOf > today) throw new AppError('VALIDATION_FAILED', '查询时点不能晚于今天', { reason: 'AS_OF_IN_FUTURE' });
    const result = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
      const current = await successionContext(c, bound, 'map');
      return readPositionMap(tx, bound, current, asOf, today);
    });
    return c.json(result);
  });
}

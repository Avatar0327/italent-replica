/**
 * 评审组成员候选（拆分方案 B3）：`GET /candidates/review-members?keyword=&page=&pageSize=`，列出查看人**人员范围内**的员工
 * （统一人员范围：员工信息的对象查看权 + 当前数据范围，同组织员工列表的谓词，分页之前生效），范围外的员工不出现、不计数。
 * 字段按员工信息的字段查看权带出（姓名、工号）；关键字只匹配查看人看得到的字段（姓名 / 工号），一个都看不到而带了关键字
 * → 403 FILTER_FIELD_HIDDEN（不能用搜索结果还原被裁掉的字段）。B5（活动负责人）、C2（评委 / 跟场人）可复用同一路由。
 */
import { sql, withTenant } from '@italent/db';
import { PERSONNEL_OBJECT } from '@italent/domain';
import type { Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields, scopeSql } from '../permission/module-access.js';
import { objectContext, requestScope } from '../permission/module-route-access.js';
import { pageQuery } from '../talent/http.js';
import { requireFilterVisible, rowsOf } from './access.js';
import { EV_BASE } from './route-support.js';

const MAX_KEYWORD = 100;

export function registerCandidates(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(`${EV_BASE}/candidates/review-members`, async (c) => {
    const ctx = await objectContext(c, deps, PERSONNEL_OBJECT, 'view');
    const page = pageQuery(c);
    const scope = await requestScope(c, deps, ctx, PERSONNEL_OBJECT);
    const fields = await getModuleViewableFields(deps, ctx, PERSONNEL_OBJECT);
    const shows = (field: string) => fields === undefined || fields.has(field);
    const keyword = c.req.query('keyword')?.trim();
    if (keyword && keyword.length > MAX_KEYWORD) throw new AppError('VALIDATION_FAILED', '关键字过长');
    const matches = [
      shows('name') ? sql`name ILIKE ${`%${escapeLike(keyword ?? '')}%`}` : null,
      shows('code') ? sql`code ILIKE ${`%${escapeLike(keyword ?? '')}%`}` : null,
    ].filter((condition) => condition !== null);
    // 姓名、工号都没有查看权时 matches 为空，'name' 必然不可见 → 403 FILTER_FIELD_HIDDEN（统一筛选守卫）
    if (keyword && !matches.length) requireFilterVisible(fields, 'name');
    const search = keyword ? sql`(${sql.join(matches, sql` OR `)})` : sql`true`;
    // 排序只用查看人看得到的字段（否则顺序与 pageSize=1 的首条会暴露隐藏工号 / 姓名的相对大小），都看不到时退回员工 ID
    const order = sql.raw(['code', 'name'].filter(shows).slice(0, 1).concat('id').join(', '));
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) =>
      rowsOf<{ id: string; name: string; code: string }>(
        await tx.execute(sql`SELECT id, name, code FROM (
            SELECT e.id, COALESCE(v.name, e.name) AS name, e.code
            FROM employment_employees e
            LEFT JOIN LATERAL (SELECT pv.name FROM personnel_employee_versions pv
              WHERE pv.tenant_id = e.tenant_id AND pv.employee_id = e.id ORDER BY pv.revision DESC LIMIT 1) v ON true
            WHERE e.tenant_id = ${ctx.tenantId}::uuid AND ${scopeSql(scope, { person: sql`e.id` })}
          ) people WHERE ${search}
          ORDER BY ${order} LIMIT ${page.limit} OFFSET ${page.offset}`),
      ),
    );
    return c.json({
      page: page.page,
      pageSize: page.pageSize,
      items: items.map((row) => ({
        id: row.id,
        ...(shows('name') ? { name: row.name } : {}),
        ...(shows('code') ? { code: row.code } : {}),
      })),
    });
  });
}

/** LIKE 通配符按字面匹配。 */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

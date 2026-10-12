/** C2：先锁定已确认的 #7 入口；职位卡片配置与 B4 接线待总编排定口径后补全。 */
// TODO(需取证 #289)：决定组织职位卡片开关与 B4 依赖后补齐卡片验收。
import { beforeAll, describe, expect, it } from 'vitest';
import { SUCCESSION_OBJECTS } from '@italent/domain';
import { useHealthDb } from './AC-SC-07-health-support.js';
import { successionWorld, SC_BASE, SC_TODAY, type SuccessionWorld } from './AC-SC-support.js';
import { tenantApi } from './support/tenant-api.js';

const db = useHealthDb();
let w: SuccessionWorld, rootId: string;
beforeAll(async () => {
  w = await successionWorld(db().db, 'sc-c2-org-map');
  rootId = (await w.org('组织地图根')).id;
});

describe('AC-SC-org-map C2 已确认入口（设计 §2.2 #7、§5.5、§5.8、§8.2）', () => {
  it('有 Map 查看权时可以读取范围内组织根', async () => {
    const response = await w.request('GET', `/maps/org?root=${rootId}&depth=3&asOf=${SC_TODAY}`);
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it.each(['1', '5', '2.5', 'abc'])('层数 %s 非法，返回 400', async (depth) => {
    const response = await w.request('GET', `/maps/org?root=${rootId}&depth=${depth}`);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('未来业务日期返回 400 AS_OF_IN_FUTURE', async () => {
    const response = await w.request('GET', `/maps/org?root=${rootId}&asOf=2026-10-02`);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { reason: 'AS_OF_IN_FUTURE' } },
    });
  });

  it('撤销 Map 查看权后返回 403', async () => {
    const api = tenantApi(w.db, {
      clock: () => new Date(`${SC_TODAY}T01:00:00.000Z`),
      authorize: (query) => !(query.action === 'object.view' && query.resource === SUCCESSION_OBJECTS.map.code),
    });
    const response = await api.request('GET', `${SC_BASE}/maps/org?root=${rootId}`, {
      user: w.user.id,
      tenant: w.tenant.id,
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});

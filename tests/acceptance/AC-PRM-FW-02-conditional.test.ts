/**
 * AC-PRM-FW-02（续，F-039 PR-A 第 4 轮）：条件准入的 HTTP 现状。显式表把两项条件准入登记为由必需的具名条件守卫承载
 * （when:<守卫>），这里用真实请求核对条件成立 / 不成立两侧（删守卫一侧见 AC-PRM-FW-02-required.test.ts）：
 * - 合同导入 mode = initialize 才另要合同删除权（contracts.importInitializeDelete）；
 * - 360 导入评价者 sync = true 才另要员工信息查看权（survey360.syncEmployees）。
 */
import type { Authorizer } from '@italent/api';
import { CONTRACT_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { fullAccess, world360 } from './AC-360-support.js';
import { contractWorld } from './AC-CT-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

/** 只拒绝合同删除权，其余全允许。 */
const noContractDelete: Authorizer = (request) =>
  !(request.action === 'object.delete' && request.resource === CONTRACT_OBJECT);

describe('条件准入：合同导入初始化另要删除权', () => {
  async function importAs(mode: 'add' | 'initialize') {
    const w = await contractWorld(testDb().db, `fw-cond-${mode}`);
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z'), authorize: noContractDelete });
    const as = { user: w.session.user.id, tenant: w.session.tenant.id };
    const head = await api.request('GET', `/api/tenant/contracts/employees/${w.employee.id}/revision`, as);
    expect(head.status, await head.clone().text()).toBe(200);
    const { revision } = (await head.json()) as { revision: number };
    return api.request('POST', '/api/tenant/contracts/imports', {
      ...as,
      ifMatch: 0,
      body: { mode, revisions: { [w.employee.id]: revision }, rows: [{ employeeId: w.employee.id, fields: w.fields }] },
    });
  }

  it('条件成立：无删除权时 initialize → 403', async () => {
    const response = await importAs('initialize');
    expect(response.status, await response.clone().text()).toBe(403);
  });

  it('条件不成立：无删除权时 add → 200', async () => {
    const response = await importAs('add');
    expect(response.status, await response.clone().text()).toBe(200);
  });
});

describe('条件准入：360 导入评价者选“同步”另要员工信息查看权', () => {
  async function importAs(sync: boolean) {
    const w = await world360(testDb().db, `fw-cond-${sync}`, { access: { ...fullAccess(), canView: false } });
    const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, peer: 1 }));
    const activity = await w.activity();
    const target = await w.person('导入对象');
    await w.object(activity.id, target.id, [q.id]);
    const row = {
      objectEmail: target.email,
      roleId: w.role('peer'),
      name: '合成评价人',
      email: `fw-cond-${sync}@example.com`,
    };
    return w.request('POST', `/activities/${activity.id}/appraisers/import`, {
      ifMatch: 0,
      body: { sync, rows: [row] },
    });
  }

  it('条件成立：无员工信息查看权时 sync = true → 403', async () => {
    const response = await importAs(true);
    expect(response.status, await response.clone().text()).toBe(403);
  });

  it('条件不成立：无员工信息查看权时 sync = false → 200', async () => {
    const response = await importAs(false);
    expect(response.status, await response.clone().text()).toBe(200);
  });
});

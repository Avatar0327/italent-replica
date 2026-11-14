/**
 * AC-PRM-FW-02（续，F-039 PR-A 第 4 轮）：条件准入的 HTTP 现状。显式表把两项条件准入登记为由必需的具名条件守卫承载
 * （when:<守卫>），这里用真实请求核对条件成立 / 不成立两侧（删守卫一侧见 AC-PRM-FW-02-required.test.ts）：
 * - 合同导入 mode = initialize 才另要合同删除权（contracts.importInitializeDelete）；
 * - 360 导入评价者 sync = true 才另要员工信息查看权（survey360.syncEmployees）；
 * - 审批模拟 resolveCurrentSources = true 才另要流程管理员（F-326 设计 §3.7 / §4.3，处理器内二次校验）。
 */
import type { Authorizer } from '@italent/api';
import { APPROVAL_PROCESS_OBJECT, CONTRACT_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { fullAccess, world360 } from './AC-360-support.js';
import { APPROVAL, counter, s4World } from './AC-APV-F326-S4-support.js';
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

describe('条件准入：审批模拟 resolveCurrentSources 另要流程管理员', () => {
  async function simulateAs(resolveCurrentSources: boolean, admin: boolean) {
    const w = await s4World(testDb().db, `fw-cond-sim-${resolveCurrentSources}-${admin}`);
    const viewer = await w.member('合成对象查看者');
    const process = await w.publishedProcess({
      isFallback: true,
      conditions: { items: [] },
      nodes: [counter([{ type: 'specified', value: w.head.userId }])],
    });
    // 对象查看者只放行流程对象 object.view；管理员全放行
    const authorize: Authorizer = (q) =>
      admin || (q.userId === viewer && q.action === 'object.view' && q.resource === APPROVAL_PROCESS_OBJECT);
    const api = tenantApi(w.db, { authorize, clock: w.clock });
    const body = { scope: 'published', data: { values: {} }, resolveCurrentSources };
    return api.request('POST', `${APPROVAL}/processes/${process.id}/simulate`, {
      ...w.as(admin ? w.hr.id : viewer),
      body,
    });
  }

  it('条件成立：对象查看者带标志 → 403', async () => {
    const response = await simulateAs(true, false);
    expect(response.status, await response.clone().text()).toBe(403);
  });

  it('条件不成立：对象查看者不带标志 → 200；管理员带标志 → 200', async () => {
    expect((await simulateAs(false, false)).status).toBe(200);
    expect((await simulateAs(true, true)).status).toBe(200);
  });
});

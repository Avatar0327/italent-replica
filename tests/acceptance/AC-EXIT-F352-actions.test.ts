/**
 * F-352①：离职详情与列表行的服务端逐单动作契约（actions）。
 * 动作 = 单据状态 × 对应按钮权（Dimission* 四个按钮，与写入口同一门禁）× 写数据范围；前端不再自行推导。
 *   submit：离职申请的草稿 / 已驳回单，HR 发起，需 Employment.DimissionApproval
 *   edit：草稿 / 审批中 / 审批通过 / 已驳回 / 已生效，需 Employment.DimissionEdit
 *   cancel：同撤销可用状态（isCancellableState），需 Employment.DimissionCancel
 *   handle（仅列表行，B15 “离职处理”）：单据已办结（审批拒绝 / 作废）且员工在写范围内，需 Employment.Dimission
 * 不暴露存在性：范围外 / 不存在的单仍统一 404，不出现在 actions 里。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons, gateWorld } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const FULL = [
  'id',
  'employeeId',
  'kind',
  'effectiveDate',
  'status',
  'revision',
  'lastWorkDate',
  'mode',
  'name',
  'code',
];

async function world(label: string) {
  const w = await gateWorld(database().db, label);
  const t = w.session.tenant.id;
  async function exit(name: string, mode: 'application' | 'direct' = 'application', lastWorkDate = '2026-10-22') {
    const { employee } = await w.hired(name);
    const { revision } = await w.session.getEmployee(employee.id);
    const response = await w.session.request('POST', `/exits/employees/${employee.id}`, {
      ifMatch: revision,
      body: { mode, lastWorkDate },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return { employee, ...((await response.json()) as { id: string; revision: number }) };
  }
  const force = (businessId: string, state: string) =>
    withTenant(database().db, t, (tx) =>
      tx.execute(sql`INSERT INTO employment_state_events(tenant_id,employee_id,business_id,payload_version_id,state,
          event_no,command_id)
        SELECT p.tenant_id,p.employee_id,p.business_id,p.id,${state},
          (SELECT coalesce(max(e.event_no),0)+1 FROM employment_state_events e
            WHERE e.tenant_id=p.tenant_id AND e.business_id=p.business_id),${`force-${randomUUID()}`}
        FROM employment_payload_versions p WHERE p.tenant_id=${t} AND p.business_id=${businessId}::uuid
        ORDER BY p.version_no DESC LIMIT 1`),
    );
  const viewer = (...denied: string[]) => w.restricted(denyButtons(...denied), undefined, FULL);
  const detail = async (api: ReturnType<typeof viewer>, id: string) =>
    (await (await api('GET', `/exits/${id}`)).json()) as { actions?: string[] };
  const row = async (api: ReturnType<typeof viewer>, id: string) =>
    (
      (await (await api('GET', '/exits?view=all')).json()) as { items: { id: string; actions?: string[] }[] }
    ).items.find((item) => item.id === id);
  return { w, exit, force, viewer, detail, row };
}

describe('F-352① 离职逐单 actions', () => {
  it('草稿申请单：详情与列表行都是 submit / edit / cancel，按钮权逐个撤销后对应动作消失', async () => {
    const x = await world('f352-draft');
    const made = await x.exit('草稿员工');
    const full = x.viewer();
    expect((await x.detail(full, made.id)).actions).toEqual(['submit', 'edit', 'cancel']);
    expect((await x.row(full, made.id))?.actions).toEqual(['submit', 'edit', 'cancel']);
    const cases: [string, string[]][] = [
      ['Employment.DimissionApproval', ['edit', 'cancel']],
      ['Employment.DimissionEdit', ['submit', 'cancel']],
      ['Employment.DimissionCancel', ['submit', 'edit']],
    ];
    for (const [button, expected] of cases) {
      const api = x.viewer(button);
      expect((await x.detail(api, made.id)).actions, button).toEqual(expected);
      expect((await x.row(api, made.id))?.actions, button).toEqual(expected);
    }
  });

  it('直接离职单没有 submit；状态决定编辑 / 撤销是否可用（已办结的单什么都没有）', async () => {
    const x = await world('f352-states');
    const direct = await x.exit('直接员工', 'direct', '2026-10-25');
    const full = x.viewer();
    expect((await x.detail(full, direct.id)).actions).toEqual(['edit', 'cancel']);
    const application = await x.exit('审批员工');
    await x.force(application.id, 'in_review');
    expect((await x.detail(full, application.id)).actions).toEqual(['edit', 'cancel']);
    await x.force(application.id, 'rejected');
    expect((await x.detail(full, application.id)).actions).toEqual(['submit', 'edit', 'cancel']);
    for (const state of ['disapproved', 'voided']) {
      await x.force(application.id, state);
      expect((await x.detail(full, application.id)).actions, state).toEqual([]);
    }
  });

  it('列表行 handle：只给已办结的单，需直接离职按钮；在途单与已生效单没有', async () => {
    const x = await world('f352-handle');
    const live = await x.exit('在途员工');
    const done = await x.exit('已办结员工');
    await x.force(done.id, 'voided');
    const full = x.viewer();
    expect((await x.row(full, live.id))?.actions ?? []).not.toContain('handle');
    expect((await x.row(full, done.id))?.actions).toEqual(['handle']);
    expect((await x.row(x.viewer('Employment.Dimission'), done.id))?.actions).toEqual([]);
    await x.force(live.id, 'effective');
    expect((await x.row(full, live.id))?.actions ?? []).not.toContain('handle');
  });

  it('动作是披露，不放宽准入：范围外的单详情仍 404，且不泄露 actions', async () => {
    const x = await world('f352-scope');
    const mine = await x.exit('本人创建');
    const other = await x.w.otherUser();
    const hr = x.w.restricted(denyButtons(), other.id);
    const outside = await hr('GET', `/exits/${mine.id}`);
    expect(outside.status).toBe(404);
    expect(await outside.clone().text()).not.toContain('actions');
  });
});

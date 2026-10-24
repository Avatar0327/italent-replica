/** F-250 / DEC-683：首次手工、提交、节点同意、生效日凌晨发起；普通角色 withTenant。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { runEmploymentActivations } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { STANDARD_GRANT_CODES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  loadProcess,
  newVersion,
  replaceDraft,
  publishProcess,
} from '../../apps/api/src/modules/approval/definitions.js';
import { handoverWorld, TODAY, type HandoverWorld } from './AC-EXIT-handover-support.js';
import { isButton, revocable } from './support/revocable-rights.js';

const database = useTestDb();
const BUTTON = 'Employment.HandoverSubmit';
const path = (id: string) => `/exits/${id}/handover/submit`;
async function world(label: string, employType = 'internal') {
  const x = await handoverWorld(database().db, `f250-${label}`);
  const employee = await x.session.employee('发起方式合成员工');
  await x.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId: x.from.id, employType },
    },
    employee.revision,
  );
  const leaverUserId = await x.applicantAccount(employee.id);
  await x.addSettingItems();
  await x.publishHandoverProcess();
  return { ...x, employee, leaverUserId };
}
async function twoExitNodes(x: HandoverWorld) {
  const [process] = await x.sqlRows<{ id: string }>(sql`SELECT id FROM approval_processes
    WHERE tenant_id=${x.tenantId} AND code='FIXTURE_leave'`);
  await withTenant(x.db, x.tenantId, async (tx) => {
    const ctx = {
      tenantId: x.tenantId,
      userId: x.processAdmin.id,
      timezone: 'Asia/Shanghai',
      now: new Date(`${TODAY}T01:00:00Z`),
      commandId: randomUUID(),
      expectedRevision: 0,
    };
    const current = await loadProcess(tx, x.tenantId, process!.id);
    const draft = await newVersion(tx, { ...ctx, expectedRevision: current.revision }, current.id);
    const node = draft.latestVersion.nodes[0]!;
    const changed = await replaceDraft(tx, { ...ctx, expectedRevision: draft.revision }, current.id, {
      ...draft.latestVersion,
      nodes: [node, { ...node, key: 'finish', name: '最终确认' }],
    });
    await publishProcess(tx, { ...ctx, expectedRevision: changed.revision }, current.id);
  });
}
async function setting(x: HandoverWorld, patch: Record<string, unknown>) {
  const url = '/api/tenant/settings/exit.handover_trigger';
  const opts = x.tenantAs(x.session.user.id);
  const before = await x.api.request('GET', url, opts);
  const current = (await before.json()) as { revision: number; value: object };
  const result = await x.api.request('PUT', url, {
    ...opts,
    ifMatch: current.revision,
    body: { value: { ...current.value, ...patch } },
  });
  expect(result.status, await result.clone().text()).toBe(200);
}
async function draft(x: HandoverWorld, mode: 'direct' | 'application' = 'application', last = '2026-10-21') {
  return x.createdExit(x.employee.id, last, mode, {
    exitTypeCode: 'voluntary',
    handoverEmployeeId: x.workOwner.employeeId,
  });
}
async function submit(x: HandoverWorld, target: { id: string; revision: number }) {
  const response = await x.session.request('POST', `/businesses/${target.id}/submit`, {
    ifMatch: target.revision,
    body: {},
  });
  expect(response.status, await response.clone().text()).toBe(200);
}
async function tick(x: HandoverWorld, at: string) {
  const result = await runEmploymentActivations(
    database().db,
    { actorUserId: null, commandId: randomUUID() },
    { tenantId: x.tenantId },
    { clock: () => new Date(at) },
  );
  expect(result.runs[0]?.errors).toEqual([]);
}
const command = (revision: number) => ({ ifMatch: revision, idempotencyKey: randomUUID(), body: {} });

describe('AC-DM-09 / F-250 手工首次交接', () => {
  it('独立详情按钮仅预置 HR 三身份，不扩大经理员工权限', () => {
    const suffix = `/TenantBase.EmploymentRecord/button:${BUTTON}@detail`;
    expect(STANDARD_GRANT_CODES.filter((code) => code.endsWith(suffix)).sort()).toEqual(
      ['standard_hr_admin', 'standard_hr_specialist', 'standard_org_system_admin'].map((code) => code + suffix),
    );
  });
  it('直接离职不自动发起；手工首次发起审计记 HR，原命令幂等；进行中及完成均不新建', async () => {
    const x = await world('manual');
    const exit = await draft(x, 'direct');
    expect(await x.requestRows(exit.id)).toEqual([]);
    const init = command(exit.revision);
    const first = await x.session.request('POST', path(exit.id), init);
    expect(first.status, await first.clone().text()).toBe(200);
    const receipt = await first.json();
    const replay = await x.session.request('POST', path(exit.id), init);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    const [request] = await x.requestRows(exit.id);
    const audit = await x.sqlRows<{ actor: string }>(sql`SELECT actor_user_id AS actor FROM audit_events
      WHERE tenant_id=${x.tenantId} AND object_id=${request!.id} AND action='exit_handover.launch'`);
    expect(audit).toEqual([{ actor: x.session.user.id }]);
    for (const complete of [false, true]) {
      if (complete) await x.approveAll(request!.instanceId!);
      const repeat = await x.session.request('POST', path(exit.id), command((await x.business(exit.id)).revision));
      expect(repeat.status).toBe(409);
      expect(await x.requestRows(exit.id)).toHaveLength(1);
    }
  });
  it('无员工账号留下未发起记录，审计仍记 HR，同键回查不重复', async () => {
    const x = await world('no-account');
    const exit = await draft(x, 'direct');
    await x.unbindAccount(x.employee.id);
    const init = command(exit.revision);
    const response = await x.session.request('POST', path(exit.id), init);
    expect(response.status, await response.clone().text()).toBe(200);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ outcome: 'not_launched' });
    const replay = await x.session.request('POST', path(exit.id), init);
    expect(await replay.json()).toEqual(receipt);
    const [request] = await x.requestRows(exit.id);
    expect(await x.requestRows(exit.id)).toHaveLength(1);
    const audit = await x.sqlRows<{ actor: string }>(sql`SELECT actor_user_id AS actor FROM audit_events
      WHERE tenant_id=${x.tenantId} AND object_id=${request!.id} AND action='exit_handover.not_launched'`);
    expect(audit).toEqual([{ actor: x.session.user.id }]);
  });
  it('范围在命令内撤回时首次与重放均 404；其他租户不可发起', async () => {
    const x = await world('scope');
    const exit = await draft(x, 'direct');
    const { rights, authorize } = revocable();
    const request = x.asUser(x.session.user.id, authorize);
    const init = command(exit.revision);
    rights.emptyScope = true;
    expect((await request('POST', path(exit.id), init)).status).toBe(404);
    expect(await x.requestRows(exit.id)).toEqual([]);
    rights.emptyScope = false;
    expect((await request('POST', path(exit.id), init)).status).toBe(200);
    rights.emptyScope = true;
    expect((await request('POST', path(exit.id), init)).status).toBe(404);
    const y = await world('other-tenant');
    expect((await y.session.request('POST', path(exit.id), command(exit.revision))).status).toBe(404);
    expect(await x.requestRows(exit.id)).toHaveLength(1);
  });
  it('并发两个首次命令只创建一个交接流程；手工模式不自动发起', async () => {
    const x = await world('concurrent');
    await setting(x, { method: 'manual' });
    const exit = await draft(x);
    await submit(x, exit);
    await x.approve(exit, `${TODAY}T02:00:00Z`);
    expect(await x.requestRows(exit.id)).toEqual([]);
    const revision = (await x.business(exit.id)).revision;
    const results = await Promise.all([1, 2].map(() => x.session.request('POST', path(exit.id), command(revision))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await x.requestRows(exit.id)).toHaveLength(1);
  });
  it('命令内首次及重放重新验按钮；旧 revision 与撤销后拒绝', async () => {
    const x = await world('guard');
    const exit = await draft(x, 'direct');
    const { rights, authorize } = revocable();
    const request = x.asUser(x.session.user.id, authorize);
    const init = command(exit.revision);
    rights.deny = isButton(BUTTON);
    expect((await request('POST', path(exit.id), init)).status).toBe(403);
    expect(await x.requestRows(exit.id)).toEqual([]);
    rights.deny = undefined;
    expect((await request('POST', path(exit.id), command(exit.revision + 1))).status).toBe(409);
    expect((await request('POST', path(exit.id), init)).status).toBe(200);
    rights.deny = isButton(BUTTON);
    expect((await request('POST', path(exit.id), init)).status).toBe(403);
    await x.cancelExit(exit.id);
    expect((await x.session.request('POST', path(exit.id), command((await x.business(exit.id)).revision))).status).toBe(
      409,
    );
  });
});

describe('AC-DM-08 / DEC-683 生效日凌晨', () => {
  it.each([15, 10, 5])('提前 %i 天批准（N=10）均等到生效日租户午夜，调度重跑不重复', async (days) => {
    const x = await world(`days-${days}`);
    await setting(x, {
      method: 'days_before_last_work_date',
      daysBeforeLastWorkDate: 10,
      includePastLastWorkDate: false,
    });
    const exit = await draft(x);
    await submit(x, exit);
    const approvedOn = `2026-10-${String(21 - days).padStart(2, '0')}`;
    await x.approve(exit, `${approvedOn}T02:00:00Z`);
    expect(await x.requestRows(exit.id)).toEqual([]);
    await tick(x, '2026-10-21T15:59:59Z');
    expect(await x.requestRows(exit.id)).toEqual([]);
    await tick(x, '2026-10-21T16:00:00Z');
    expect(await x.requestRows(exit.id)).toMatchObject([{ state: 'in_progress' }]);
    await tick(x, '2026-10-21T16:05:00Z');
    expect(await x.requestRows(exit.id)).toHaveLength(1);
  });
  it.each([
    [TODAY, false, true],
    ['2026-10-05', true, true],
    ['2026-10-05', false, false],
  ] as const)('L=%s includePast=%s：批准立即分支=%s', async (last, includePastLastWorkDate, launch) => {
    const x = await world(`immediate-${last}-${includePastLastWorkDate}`);
    await setting(x, { method: 'days_before_last_work_date', daysBeforeLastWorkDate: 10, includePastLastWorkDate });
    const exit = await draft(x, 'application', last);
    await submit(x, exit);
    await x.approve(exit, `${TODAY}T02:00:00Z`);
    expect(await x.requestRows(exit.id)).toHaveLength(launch ? 1 : 0);
  });
  it('批准后撤销或关闭开关，生效日调度不补发', async () => {
    for (const cancel of [true, false]) {
      const x = await world(`cancel-${cancel}`);
      await setting(x, { method: 'days_before_last_work_date', daysBeforeLastWorkDate: 10 });
      const exit = await draft(x);
      await submit(x, exit);
      await x.approve(exit, `${TODAY}T02:00:00Z`);
      if (cancel) await x.cancelExit(exit.id);
      else await setting(x, { enabled: false });
      await tick(x, '2026-10-21T16:00:00Z');
      expect(await x.requestRows(exit.id)).toEqual([]);
    }
  });
  it('直接离职到期也不自动发起；关闭开关不发起', async () => {
    const x = await world('direct-due');
    await setting(x, { method: 'days_before_last_work_date', daysBeforeLastWorkDate: 10 });
    const exit = await draft(x, 'direct');
    await tick(x, '2026-10-21T16:00:00Z');
    expect(await x.requestRows(exit.id)).toEqual([]);
    const y = await world('disabled-due');
    await setting(y, { method: 'days_before_last_work_date', daysBeforeLastWorkDate: 10, enabled: false });
    const other = await draft(y);
    await submit(y, other);
    await y.approve(other, `${TODAY}T02:00:00Z`);
    await tick(y, '2026-10-21T16:00:00Z');
    expect(await y.requestRows(other.id)).toEqual([]);
  });
});

describe('DM-R13 提交与节点同意触发', () => {
  it('提交时发起，批准后不重复；关闭开关不发起', async () => {
    for (const enabled of [true, false]) {
      const x = await world(`submit-${enabled}`);
      await setting(x, { method: 'on_submit', enabled });
      const exit = await draft(x);
      await submit(x, exit);
      expect(await x.requestRows(exit.id)).toHaveLength(enabled ? 1 : 0);
      await x.approve(exit, `${TODAY}T02:00:00Z`);
      expect(await x.requestRows(exit.id)).toHaveLength(enabled ? 1 : 0);
    }
  });
  it.each(['intern', 'external'])('雇佣关系 %s：只有内部员工与实习生可被提交触发', async (employType) => {
    const x = await world(`type-${employType}`, employType);
    await setting(x, { method: 'on_submit' });
    const exit = await draft(x);
    await submit(x, exit);
    expect(await x.requestRows(exit.id)).toHaveLength(employType === 'intern' ? 1 : 0);
  });
  it('指定节点实际同意后发起，提交时尚未发起', async () => {
    const x = await world('node');
    await twoExitNodes(x);
    // 先提交以取得该测试流程的真实节点标识，再设置目标；设置不追溯触发。
    await setting(x, { method: 'on_node_approved', nodeKey: 'placeholder' });
    const exit = await draft(x);
    await submit(x, exit);
    expect(await x.requestRows(exit.id)).toEqual([]);
    const [task] = await x.sqlRows<{ nodeKey: string }>(sql`SELECT t.node_key AS "nodeKey" FROM approval_tasks t
      JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
      WHERE t.tenant_id=${x.tenantId} AND i.business_id=${exit.id}::uuid AND t.status='pending'`);
    await setting(x, { nodeKey: task!.nodeKey });
    await x.approveInReview(exit.id);
    expect((await x.business(exit.id)).status).toBe('in_review');
    const [request] = await x.requestRows(exit.id);
    expect(request!.state).toBe('in_progress');
    await x.approveAll(request!.instanceId!);
    await setting(x, { nodeKey: 'finish' });
    await x.approveInReview(exit.id);
    expect(await x.requestRows(exit.id)).toMatchObject([{ id: request!.id, state: 'completed' }]);
  });
});

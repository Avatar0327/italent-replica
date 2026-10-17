/**
 * R2-T03 B2b / AC-DM-33 B-86（DEC-499 / 设计 §7.2）：编辑离职 PATCH exits/:id 只改非日期字段；最后工作日 / 生效日与当前值
 * 不同 → 400 EXIT_DATE_IMMUTABLE（draft / in_review / rejected / approved / effective 五种状态），且无任何业务写入、
 * 同键重放同一拒绝；无 DimissionEdit 先得 403。记录编辑 / 批量编辑 / 导入编辑行对离职记录沿用 main 的
 * RECORD_DATE_IMMUTABLE，整批回滚。B-65a：in_review 单的 HR PATCH 另需审批管理员按钮（adminIntervene）。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { denyButtons, gateWorld, leaveBody, type GateWorld } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const LATER = '2026-10-20';
const exit = { exitTypeCode: 'voluntary' };

async function submit(w: GateWorld, target: { id: string; revision: number }) {
  const sent = await w.session.request('POST', `/exits/${target.id}/submit`, { ifMatch: target.revision, body: {} });
  expect(sent.status, await sent.clone().text()).toBe(200);
  return (await sent.json()) as { id: string; revision: number };
}

/** 五种状态的离职单各一张（每人一张）。 */
async function fiveStates(w: GateWorld) {
  const person = async (name: string) => (await w.hired(name)).employee.id;
  const draft = await w.createdLeave(await person('草稿'), leaveBody(LATER, 'application', exit));
  const inReview = await submit(w, await w.createdLeave(await person('审批中'), leaveBody(LATER, 'application', exit)));
  const toReject = await submit(w, await w.createdLeave(await person('已驳回'), leaveBody(LATER, 'application', exit)));
  const rejected = await runEmploymentTransition(
    w.db,
    {
      tenantId: w.session.tenant.id,
      userId: w.session.user.id,
      timezone: w.session.tenant.timezone,
      now: new Date('2026-10-06T02:00:00Z'),
      commandId: randomUUID(),
      expectedRevision: toReject.revision,
    },
    { id: toReject.id, action: 'reject' },
  );
  expect(rejected.status).toBe(200);
  const approved = await w.createdLeave(await person('已批准'), leaveBody(LATER, 'direct', exit));
  const effective = await w.effectiveExit(await person('已生效'));
  const states = { draft, in_review: inReview, rejected: toReject, approved, effective };
  return Promise.all(
    Object.entries(states).map(async ([state, target]) => ({
      state,
      business: (await w.business(target.id)) as Awaited<ReturnType<GateWorld['business']>> & { lastWorkDate: string },
    })),
  );
}

describe('AC-DM-33 B-86 PATCH exits/:id 五种状态', () => {
  it('改最后工作日或生效日：400 EXIT_DATE_IMMUTABLE，前后读取逐项相等，同键重放同一拒绝', async () => {
    const w = await gateWorld(database().db, 'edit-dates');
    for (const { state, business } of await fiveStates(w)) {
      expect(business.status).toBe(state);
      const before = await w.stateOf(business.employeeId);
      for (const patch of [
        { lastWorkDate: '2026-09-25' },
        { effectiveDate: '2026-10-30', exitTypeCode: 'involuntary' },
      ]) {
        const key = randomUUID();
        const send = () =>
          w.session.request('PATCH', `/exits/${business.id}`, {
            ifMatch: business.revision,
            body: patch,
            idempotencyKey: key,
          });
        for (const attempt of [await send(), await send()])
          expect(await w.reason(attempt), `${state} ${JSON.stringify(patch)}`).toMatchObject({
            status: 400,
            code: 'VALIDATION_FAILED',
            reason: 'EXIT_DATE_IMMUTABLE',
          });
      }
      expect(await w.stateOf(business.employeeId), state).toEqual(before);
    }
  });

  it('对照：日期与当前值相同 + 非日期字段 → 200 只改非日期字段并记 exit.request.update；无 DimissionEdit 先 403', async () => {
    const w = await gateWorld(database().db, 'edit-fields');
    const noEdit = w.restricted(denyButtons('Employment.DimissionEdit'));
    for (const { state, business } of await fiveStates(w)) {
      const before = await w.stateOf(business.employeeId);
      const denied = await noEdit('PATCH', `/exits/${business.id}`, {
        ifMatch: business.revision,
        body: { lastWorkDate: '2026-09-25' },
      });
      expect(denied.status, state).toBe(403);
      expect(await w.stateOf(business.employeeId)).toEqual(before);
      const ok = await w.session.request('PATCH', `/exits/${business.id}`, {
        ifMatch: business.revision,
        body: { lastWorkDate: business.lastWorkDate, exitTypeCode: 'involuntary', compensationAmount: 1200.5 },
      });
      expect(ok.status, `${state} ${await ok.clone().text()}`).toBe(200);
      expect(await w.exitRow(business.id)).toMatchObject({ exit_type_code: 'involuntary' });
      const after = (await w.business(business.id)) as typeof business;
      expect({ status: after.status, lastWorkDate: after.lastWorkDate }).toEqual({
        status: business.status,
        lastWorkDate: business.lastWorkDate,
      });
      const [audit] = await w.sqlRows<{ before: object; after: object }>(sql`SELECT before, after FROM audit_events
        WHERE tenant_id=${w.session.tenant.id} AND action='exit.request.update' AND object_id=${business.id}`);
      expect(audit, state).toMatchObject({
        // 已生效的单是可信造数（无离职类型）
        before: { exitTypeCode: state === 'effective' ? null : 'voluntary', compensationAmount: null },
        after: { exitTypeCode: 'involuntary', compensationAmount: '1200.50' },
      });
    }
  });

  it('B-65a in_review 单：只有 DimissionEdit、无审批管理员按钮 → 403 无写入；两者齐全 → 200', async () => {
    const w = await gateWorld(database().db, 'edit-in-review');
    const { employee } = await w.hired();
    const inReview = await submit(w, await w.createdLeave(employee.id, leaveBody(LATER, 'application', exit)));
    const before = await w.stateOf(employee.id);
    const body = { whereaboutsCode: 'startup' };
    const noAdmin = w.restricted(denyButtons('adminIntervene'));
    const denied = await noAdmin('PATCH', `/exits/${inReview.id}`, { ifMatch: inReview.revision, body });
    expect(denied.status).toBe(403);
    expect(await w.stateOf(employee.id)).toEqual(before);
    const ok = await w.session.request('PATCH', `/exits/${inReview.id}`, { ifMatch: inReview.revision, body });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.exitRow(inReview.id)).toMatchObject({ whereabouts_code: 'startup' });
  });

  it('不是离职单 → 404；非离职字段 400', async () => {
    const w = await gateWorld(database().db, 'edit-misc');
    const { employee } = await w.hired();
    const transfer = await w.apply(employee.id, '2026-10-25', { departmentId: w.to.id });
    const notExit = await w.session.request('PATCH', `/exits/${transfer.id}`, {
      ifMatch: transfer.revision,
      body: { exitTypeCode: 'voluntary' },
    });
    expect(notExit.status).toBe(404);
    const other = (await w.hired('第二人')).employee;
    const draft = await w.createdLeave(other.id, leaveBody(LATER, 'application', exit));
    const invalid = await w.session.request('PATCH', `/exits/${draft.id}`, {
      ifMatch: draft.revision,
      body: { place: '不是离职字段' },
    });
    expect(invalid.status).toBe(400);
  });
});

describe('AC-DM-33 B-86 记录编辑 / 批量编辑 / 导入编辑行对离职记录：RECORD_DATE_IMMUTABLE，整批回滚', () => {
  it('三个入口带日期键一律 400，前后读取逐项相等；同一入口只改非日期字段 200', async () => {
    const w = await gateWorld(database().db, 'edit-records');
    const { employee } = await w.hired('离职员工');
    const leave = await w.effectiveExit(employee.id);
    const peers = [(await w.hired('同批一')).hire, (await w.hired('同批二')).hire];
    const all = [
      employee.id,
      ...(await Promise.all(peers.map(async (hire) => (await w.business(hire.id)).employeeId))),
    ];
    const snapshot = () => Promise.all(all.map((id) => w.stateOf(id)));
    const before = await snapshot();
    const record = await w.business(leave.id);
    const expectImmutable = async (response: Response) =>
      expect(await w.reason(response)).toMatchObject({ status: 400, reason: 'RECORD_DATE_IMMUTABLE' });
    await expectImmutable(
      await w.session.request('PATCH', `/records/${leave.id}`, {
        ifMatch: record.revision,
        body: { lastWorkDate: '2026-09-25' },
      }),
    );
    const items = await Promise.all(
      [leave, ...peers].map(async (target) => ({ id: target.id, revision: (await w.business(target.id)).revision })),
    );
    await expectImmutable(
      await w.session.request('POST', '/records/batch-edit', {
        body: { items, patch: { lastWorkDate: '2026-09-25', fields: { place: '批量' } } },
      }),
    );
    const { revision } = await w.session.getEmployee(employee.id);
    await expectImmutable(
      await w.session.request('POST', `/employees/${employee.id}/import`, {
        ifMatch: revision,
        body: {
          items: [
            { operation: 'edit', id: leave.id, revision: record.revision, patch: { effectiveDate: '2026-10-05' } },
          ],
        },
      }),
    );
    expect(await snapshot()).toEqual(before);
    const ok = await w.session.request('PATCH', `/records/${leave.id}`, {
      ifMatch: record.revision,
      body: { fields: { remarks: '离职备注' } },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });
});

describe('AC-DM-22 #388 P2-1 审批中 HR 编辑离职字段使旧审批页面失效（审批版本覆盖离职扩展字段）', () => {
  const changes: [string, Record<string, unknown>][] = [
    ['离职类型', { exitTypeCode: 'involuntary' }],
    ['离职原因', { reasonCode: 'family' }],
    ['补偿金', { compensationAmount: 8800 }],
  ];
  for (const [label, body] of changes)
    it(`${label}被 HR 改过：旧实例 revision 同意 409，刷新后同意通过`, async () => {
      const w = await gateWorld(database().db, `edit-version-${Object.keys(body)[0]}`);
      const { employee } = await w.hired();
      const exitBody = { exitTypeCode: 'voluntary', reasonCode: 'personal', compensationAmount: 100 };
      const sent = await submit(w, await w.createdLeave(employee.id, leaveBody(LATER, 'application', exitBody)));
      const taskOf = async () =>
        (
          await w.sqlRows<{ id: string; assignee: string; revision: number }>(sql`SELECT t.id,
            t.assignee_user_id AS assignee, i.revision FROM approval_tasks t
          JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
          WHERE t.tenant_id=${w.session.tenant.id} AND i.business_id=${sent.id}::uuid AND t.status='pending'`)
        )[0]!;
      const stale = await taskOf();
      const approve = (revision: number) =>
        w.asUser(stale.assignee)('POST', `/../approval/tasks/${stale.id}/approve`, { ifMatch: revision, body: {} });
      const patched = await w.session.request('PATCH', `/exits/${sent.id}`, { ifMatch: sent.revision, body });
      expect(patched.status, await patched.clone().text()).toBe(200);
      const old = await approve(Number(stale.revision));
      expect(old.status, await old.clone().text()).toBe(409);
      expect((await w.business(sent.id)).status).toBe('in_review');
      const ok = await approve(Number((await taskOf()).revision));
      expect(ok.status, await ok.clone().text()).toBe(200);
      expect((await w.business(sent.id)).status).toBe('approved');
    });
});

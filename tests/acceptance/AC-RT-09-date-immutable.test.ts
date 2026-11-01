/**
 * R2-T04 BE-5a / AC-RT-09（c1，DEC-636）：退休日期（最后工作日 L、生效日 E）创建后任何人工入口、任何状态都不可改，
 * 需要调整就撤销后重建。入口：PATCH retirements/:id、通用 PATCH businesses/:id、审批编辑、编辑并同意；
 * 判定在权限链之后、首个写之前，被拒时前后读取逐项相等。编辑退休要 Employment.RetireEdit（不是 DimissionEdit）。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { approvalWorld, transferScene } from './AC-APV-support.js';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { stateSnapshot } from './AC-EXIT-gate-support.js';
import { retireBody, retirementWorld, type RetirementWorld } from './AC-RT-support.js';

const database = useTestDb();
const LATER = '2026-10-20';

const reasonOf = async (response: Response) => {
  const body = (await response.json()) as { error?: { code?: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
};

/** 各状态的退休单（每人一张）：draft / in_review / rejected / approved / effective。 */
async function states(x: RetirementWorld) {
  const person = async (name: string) => (await x.hired(name)).employee.id;
  const draft = await x.createdRetire(await person('草稿'), retireBody(LATER));
  const inReview = await x.submittedRetire(LATER, await person('审批中'));
  const rejected = await x.submittedRetire(LATER, await person('已驳回'));
  const result = await runEmploymentTransition(
    x.db,
    {
      tenantId: x.session.tenant.id,
      userId: x.session.user.id,
      timezone: x.session.tenant.timezone,
      now: new Date('2026-10-06T02:00:00Z'),
      commandId: randomUUID(),
      expectedRevision: (await x.business(rejected.id)).revision,
    },
    { id: rejected.id, action: 'reject' },
  );
  expect(result.status).toBe(200);
  const approved = await x.createdRetire(await person('已批准'), retireBody(LATER, 'direct'));
  const effective = await x.createdRetire(await person('已生效'), retireBody('2026-10-01', 'direct'));
  expect(effective.status).toBe('effective');
  const all = { draft, in_review: inReview, rejected, approved, effective };
  return Promise.all(
    Object.entries(all).map(async ([state, target]) => ({ state, business: await x.business(target.id) })),
  );
}

describe('AC-RT-09 PATCH retirements/:id 与通用 PATCH businesses/:id：五种状态', () => {
  it('改最后工作日或生效日：400 EXIT_DATE_IMMUTABLE，前后读取逐项相等', async () => {
    const x = await retirementWorld(database().db, 'rt09-patch');
    for (const { state, business } of await states(x)) {
      expect(business.status).toBe(state);
      const before = await x.stateOf(business.employeeId);
      for (const patch of [{ lastWorkDate: '2026-10-25' }, { effectiveDate: '2026-10-26' }]) {
        for (const [method, path] of [
          ['PATCH', `/retirements/${business.id}`],
          ['PATCH', `/businesses/${business.id}`],
        ] as const) {
          const response = await x.session.request(method, path, { ifMatch: business.revision, body: patch });
          expect(await reasonOf(response), `${state} ${path} ${JSON.stringify(patch)}`).toMatchObject({
            status: 400,
            reason: 'EXIT_DATE_IMMUTABLE',
          });
        }
      }
      expect(await x.stateOf(business.employeeId), state).toEqual(before);
    }
  });

  it('日期与当前值相同 + 非日期字段 → 200，只改非日期字段；无 RetireEdit 先得 403（DimissionEdit 不能代替）', async () => {
    const x = await retirementWorld(database().db, 'rt09-ok');
    const colleague = await x.session.employee('交接人');
    const draft = await x.createdRetire(x.employee.id, retireBody(LATER));
    const current = await x.business(draft.id);
    const before = await x.stateOf(x.employee.id);
    const denied = await x.restricted(denyButtons('Employment.RetireEdit'))('PATCH', `/retirements/${draft.id}`, {
      ifMatch: current.revision,
      body: { lastWorkDate: '2026-10-25' },
    });
    expect(denied.status).toBe(403);
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    const ok = await x.session.request('PATCH', `/retirements/${draft.id}`, {
      ifMatch: current.revision,
      body: { lastWorkDate: LATER, handoverEmployeeId: colleague.id },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await x.exitRow(draft.id)).toMatchObject({ handover_employee_id: colleague.id });
    expect(await x.business(draft.id)).toMatchObject({ effectiveDate: '2026-10-21' });
    expect(await x.audits(draft.id, 'retirement.request.update')).toHaveLength(1);
  });

  it('离职专用字段与返聘键：400（RETIREMENT_FIELD_NOT_ALLOWED / RETIREMENT_FIELD_IMMUTABLE），无写入；离职单 404', async () => {
    const x = await retirementWorld(database().db, 'rt09-fields');
    const draft = await x.createdRetire(x.employee.id, retireBody(LATER));
    const { revision } = await x.business(draft.id);
    const before = await x.stateOf(x.employee.id);
    for (const [body, reason] of [
      [{ exitTypeCode: 'voluntary' }, 'RETIREMENT_FIELD_NOT_ALLOWED'],
      [{ reasonCode: 'personal' }, 'RETIREMENT_FIELD_NOT_ALLOWED'],
      [{ reEmployed: true }, 'RETIREMENT_FIELD_IMMUTABLE'],
      [{ rehire: {} }, 'RETIREMENT_FIELD_IMMUTABLE'],
    ] as const) {
      const response = await x.session.request('PATCH', `/retirements/${draft.id}`, { ifMatch: revision, body });
      expect(await reasonOf(response), JSON.stringify(body)).toMatchObject({ status: 400, reason });
    }
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    const other = await x.hired('离职人');
    const leave = await x.createdLeave(other.employee.id, { kind: 'leave', mode: 'application', lastWorkDate: LATER });
    const wrong = await x.session.request('PATCH', `/retirements/${leave.id}`, { ifMatch: leave.revision, body: {} });
    expect(wrong.status).toBe(404);
  });
});

describe('AC-RT-09 审批编辑与编辑并同意', () => {
  async function scene(label: string, editMode: 'separate' | 'with_approve') {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    await w.publishedProcess({
      approvalType: 'retirement',
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'RetireProcess' }] },
      nodes: [
        {
          key: 'out_head',
          approver: { type: 'department', value: 'latest_record_department_head' },
          formFields: ['lastWorkDate', 'effectiveDate', 'place'],
          editableFields: ['lastWorkDate', 'place'],
          editMode,
        },
      ],
    });
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
    );
    const draft = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
        ifMatch: employee.revision,
        body: { kind: 'retirement', mode: 'application', lastWorkDate: LATER, fields: {} },
      }),
      201,
    );
    const instance = await w.submit(draft);
    return { w, s, draft, instance, task: w.pending(instance)[0]! };
  }

  it('审批编辑改最后工作日：400 EXIT_DATE_IMMUTABLE，任务 / 实例 / 业务不变；改非日期字段 200', async () => {
    const { w, s, draft, instance, task } = await scene('rt09-edit', 'separate');
    const before = await stateSnapshot(w.db, w.tenant.id, s.subject.employeeId);
    const rejected = await w.taskAction(s.outHead.userId, task.id, 'edit', instance.revision, {
      fields: { lastWorkDate: '2026-10-25' },
    });
    expect(await reasonOf(rejected)).toMatchObject({ status: 400, reason: 'EXIT_DATE_IMMUTABLE' });
    expect(await stateSnapshot(w.db, w.tenant.id, s.subject.employeeId)).toEqual(before);
    expect(await w.business(draft.id)).toMatchObject({ status: 'in_review', effectiveDate: '2026-10-21' });
    const ok = await w.taskAction(s.outHead.userId, task.id, 'edit', instance.revision, {
      fields: { place: '改地点' },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.business(draft.id)).toMatchObject({ effectiveDate: '2026-10-21', fields: { place: '改地点' } });
  });

  it('编辑并同意带日期改动：整个同意动作失败，任务仍待办；日期未变的同意通过，且不要求离职类型', async () => {
    const { w, s, draft, instance, task } = await scene('rt09-approve', 'with_approve');
    const before = await stateSnapshot(w.db, w.tenant.id, s.subject.employeeId);
    const rejected = await w.taskAction(s.outHead.userId, task.id, 'approve', instance.revision, {
      fields: { lastWorkDate: '2026-10-25', place: '改地点' },
    });
    expect(await reasonOf(rejected)).toMatchObject({ status: 400, reason: 'EXIT_DATE_IMMUTABLE' });
    expect(await stateSnapshot(w.db, w.tenant.id, s.subject.employeeId)).toEqual(before);
    expect(w.pending(await w.detail(instance.id)).map((t) => t.id)).toEqual([task.id]);
    const ok = await w.taskAction(s.outHead.userId, task.id, 'approve', instance.revision, {
      fields: { lastWorkDate: LATER, place: '改地点' },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.business(draft.id)).toMatchObject({ status: 'approved', fields: { place: '改地点' } });
  });
});

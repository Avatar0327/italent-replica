/**
 * R2-T03 B2a / AC-DM-33 B-86（DEC-499）：最后工作日只在创建时填写，此后任何人工入口改日期一律拒绝且无任何业务写入。
 * 本批覆盖经 updateEmploymentBusiness 的三个入口：通用 PATCH businesses/:id（draft / rejected / approved）、
 * 审批编辑（edit）、编辑并同意（approve 带 fields）；records / batch-edit / 导入编辑行与 PATCH exits/:id 归 B2b。
 * 判定在权限链之后、首个写之前：无 DimissionEdit 先得 403；日期与当前值相同不算修改。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { approvalWorld, transferScene } from './AC-APV-support.js';
import { denyButtons, gateWorld, leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const LATER = '2026-10-20';

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error?: { code?: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
}

describe('AC-DM-33 B-86 通用 PATCH businesses/:id', () => {
  async function states() {
    const w = await gateWorld(database().db, 'immutable-patch');
    const { employee } = await w.hired();
    const draft = await w.createdLeave(employee.id, leaveBody(LATER));
    const rejected = await w.createdLeave((await w.hired('第二人')).employee.id, leaveBody(LATER));
    const sent = await w.session.request('POST', `/businesses/${rejected.id}/submit`, {
      ifMatch: rejected.revision,
      body: {},
    });
    expect(sent.status).toBe(200);
    const current = await w.business(rejected.id);
    const result = await runEmploymentTransition(
      w.db,
      {
        tenantId: w.session.tenant.id,
        userId: w.session.user.id,
        timezone: w.session.tenant.timezone,
        now: new Date('2026-10-06T02:00:00Z'),
        commandId: randomUUID(),
        expectedRevision: current.revision,
      },
      { id: rejected.id, action: 'reject' },
    );
    expect(result.status).toBe(200);
    const approved = await w.createdLeave((await w.hired('第三人')).employee.id, leaveBody(LATER, 'direct'));
    return { w, draft, rejected: await w.business(rejected.id), approved: await w.business(approved.id) };
  }

  it('draft / rejected / approved 改最后工作日或生效日：400 EXIT_DATE_IMMUTABLE，前后读取逐项相等，同键重放同一拒绝', async () => {
    const { w, draft, rejected, approved } = await states();
    expect(rejected.status).toBe('rejected');
    for (const target of [draft, rejected, approved]) {
      const employeeId = (await w.business(target.id)).employeeId;
      const before = await w.stateOf(employeeId);
      for (const patch of [{ lastWorkDate: '2026-10-25' }, { effectiveDate: '2026-10-26' }]) {
        const key = randomUUID();
        const send = () =>
          w.session.request('PATCH', `/businesses/${target.id}`, {
            ifMatch: target.revision,
            body: patch,
            idempotencyKey: key,
          });
        expect(await w.reason(await send()), JSON.stringify(patch)).toMatchObject({
          status: 400,
          code: 'VALIDATION_FAILED',
          reason: 'EXIT_DATE_IMMUTABLE',
        });
        expect(await w.reason(await send())).toMatchObject({ status: 400, reason: 'EXIT_DATE_IMMUTABLE' });
      }
      expect(await w.stateOf(employeeId)).toEqual(before);
    }
  });

  it('对照：日期与当前值相同 + 非日期字段 → 200，只改非日期字段；无 DimissionEdit 先得 403', async () => {
    const { w, draft } = await states();
    const body = { lastWorkDate: LATER, fields: { place: '新地点' } };
    const denied = await w.restricted(denyButtons('Employment.DimissionEdit'))('PATCH', `/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { lastWorkDate: '2026-10-25' },
    });
    expect(denied.status).toBe(403);
    const ok = await w.session.request('PATCH', `/businesses/${draft.id}`, { ifMatch: draft.revision, body });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.business(draft.id)).toMatchObject({ effectiveDate: '2026-10-21', fields: { place: '新地点' } });
  });
});

describe('AC-DM-33 B-86 审批编辑与编辑并同意', () => {
  async function scene(label: string, editMode: 'separate' | 'with_approve') {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    await w.publishedProcess({
      approvalType: 'leave',
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }] },
      nodes: [
        {
          key: 'out_head',
          approver: 'latest_record_department_head',
          formFields: ['lastWorkDate', 'effectiveDate', 'place'],
          editableFields: ['lastWorkDate', 'place'],
          editMode,
        },
      ],
    });
    const draft = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
        ifMatch: (
          await w.json<{ revision: number }>(
            await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
          )
        ).revision,
        body: { kind: 'leave', mode: 'application', lastWorkDate: LATER, fields: {} },
      }),
      201,
    );
    const instance = await w.submit(draft);
    return { w, s, draft, instance, task: w.pending(instance)[0]! };
  }

  it('审批编辑改最后工作日：400 EXIT_DATE_IMMUTABLE，任务 / 实例 / 业务不变；改非日期字段 200', async () => {
    const { w, s, draft, instance, task } = await scene('immutable-edit', 'separate');
    const rejected = await w.taskAction(s.outHead.userId, task.id, 'edit', instance.revision, {
      fields: { lastWorkDate: '2026-10-25' },
    });
    expect(await reasonOf(rejected)).toMatchObject({ status: 400, reason: 'EXIT_DATE_IMMUTABLE' });
    const after = await w.detail(instance.id);
    expect({ revision: after.revision, tasks: after.tasks }).toEqual({
      revision: instance.revision,
      tasks: instance.tasks,
    });
    expect(await w.business(draft.id)).toMatchObject({ status: 'in_review', effectiveDate: '2026-10-21' });
    const ok = await w.taskAction(s.outHead.userId, task.id, 'edit', instance.revision, {
      fields: { place: '改地点' },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.business(draft.id)).toMatchObject({ effectiveDate: '2026-10-21', fields: { place: '改地点' } });
  });

  it('编辑并同意带日期改动：整个同意动作失败，任务仍待办、节点不推进；日期未变的同意通过', async () => {
    const { w, s, draft, instance, task } = await scene('immutable-approve', 'with_approve');
    const rejected = await w.taskAction(s.outHead.userId, task.id, 'approve', instance.revision, {
      fields: { lastWorkDate: '2026-10-25', place: '改地点' },
    });
    expect(await reasonOf(rejected)).toMatchObject({ status: 400, reason: 'EXIT_DATE_IMMUTABLE' });
    const after = await w.detail(instance.id);
    expect(after.revision).toBe(instance.revision);
    expect(w.pending(after).map((t) => t.id)).toEqual([task.id]);
    expect(await w.business(draft.id)).toMatchObject({ status: 'in_review', effectiveDate: '2026-10-21' });
    const ok = await w.taskAction(s.outHead.userId, task.id, 'approve', instance.revision, {
      fields: { lastWorkDate: LATER, place: '改地点' },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.business(draft.id)).toMatchObject({ status: 'approved', fields: { place: '改地点' } });
  });
});

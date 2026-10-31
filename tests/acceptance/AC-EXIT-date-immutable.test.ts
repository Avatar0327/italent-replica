/**
 * R2-T03 B2a / AC-DM-33 B-86（DEC-499）：F-140b1 开放未生效离职改期；通用 approved 入口仍拒绝。
 * 本批覆盖经 updateEmploymentBusiness 的三个入口：通用 PATCH businesses/:id（draft / rejected / approved）、
 * 审批编辑（edit）、编辑并同意（approve 带 fields）；records / batch-edit / 导入编辑行与 PATCH exits/:id 归 B2b。
 * 判定在权限链之后、首个写之前：无 DimissionEdit 先得 403；日期与当前值相同不算修改。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { approvalWorld, transferScene } from './AC-APV-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { denyButtons, gateWorld, leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const LATER = '2026-10-20';

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

  it('draft / rejected 改期可重放；approved 通用入口仍拒绝且无写入', async () => {
    const { w, draft, rejected, approved } = await states();
    for (const target of [draft, rejected, approved]) {
      const before = await w.stateOf((await w.business(target.id)).employeeId);
      const key = randomUUID();
      const send = () =>
        w.session.request('PATCH', `/businesses/${target.id}`, {
          ifMatch: target.revision,
          body: { lastWorkDate: '2026-10-25', effectiveDate: '2026-10-26' },
          idempotencyKey: key,
        });
      for (const response of [await send(), await send()]) {
        if (target.id === approved.id)
          expect(await w.reason(response)).toMatchObject({ status: 400, reason: 'EXIT_DATE_IMMUTABLE' });
        else expect(response.status, await response.clone().text()).toBe(200);
      }
      if (target.id === approved.id) expect(await w.stateOf(approved.employeeId)).toEqual(before);
      else expect(await w.business(target.id)).toMatchObject({ effectiveDate: '2026-10-26' });
    }
  });

  it('对照：日期与当前值相同 + 非日期字段 → 200，只改非日期字段；无 DimissionEdit 先得 403', async () => {
    const { w, draft } = await states();
    const body = { lastWorkDate: LATER, fields: { place: '新地点' } };
    const employeeId = (await w.business(draft.id)).employeeId;
    const before = await w.stateOf(employeeId);
    const denied = await w.restricted(denyButtons('Employment.DimissionEdit'))('PATCH', `/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { lastWorkDate: '2026-10-25' },
    });
    expect(denied.status).toBe(403);
    expect(await w.stateOf(employeeId)).toEqual(before);
    const ok = await w.session.request('PATCH', `/businesses/${draft.id}`, { ifMatch: draft.revision, body });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.business(draft.id)).toMatchObject({ effectiveDate: '2026-10-21', fields: { place: '新地点' } });
  });
});

describe('AC-DM-33 B-86 审批编辑与编辑并同意', () => {
  async function scene(label: string, editMode: 'separate' | 'with_approve') {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    await installExitSeeds(w.db, w.tenant.id);
    await w.publishedProcess({
      approvalType: 'leave',
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }] },
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
    const draft = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
        ifMatch: (
          await w.json<{ revision: number }>(
            await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
          )
        ).revision,
        body: {
          kind: 'leave',
          mode: 'application',
          lastWorkDate: LATER,
          fields: {},
          exit: { exitTypeCode: 'voluntary' },
        },
      }),
      201,
    );
    const instance = await w.submit(draft);
    return { w, s, draft, instance, task: w.pending(instance)[0]! };
  }

  it('审批编辑改期刷新实例；旧 revision 拒绝，刷新后可继续改字段', async () => {
    const { w, s, draft, instance, task } = await scene('replan-edit', 'separate');
    const changed = await w.taskAction(s.outHead.userId, task.id, 'edit', instance.revision, {
      fields: { lastWorkDate: '2026-10-25' },
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(await w.business(draft.id)).toMatchObject({ status: 'in_review', effectiveDate: '2026-10-26' });
    const after = await w.detail(instance.id);
    expect(after.revision).toBeGreaterThan(instance.revision);
    expect(
      (await w.taskAction(s.outHead.userId, task.id, 'edit', instance.revision, { fields: { place: '改地点' } }))
        .status,
    ).toBe(409);
    const ok = await w.taskAction(s.outHead.userId, task.id, 'edit', after.revision, { fields: { place: '改地点' } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.business(draft.id)).toMatchObject({ effectiveDate: '2026-10-26', fields: { place: '改地点' } });
  });

  it('编辑并同意带改期：按新日期批准，未来日期留待调度', async () => {
    const { w, s, draft, instance, task } = await scene('replan-approve', 'with_approve');
    const ok = await w.taskAction(s.outHead.userId, task.id, 'approve', instance.revision, {
      fields: { lastWorkDate: '2026-10-25', place: '改地点' },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.business(draft.id)).toMatchObject({
      status: 'approved',
      effectiveDate: '2026-10-26',
      fields: { place: '改地点' },
    });
    expect(w.pending(await w.detail(instance.id))).toHaveLength(0);
  });
  it.each(['separate', 'with_approve'] as const)(
    'F-140 审批 %s：确认控制项与字段分开，409 后可携新令牌重提',
    async (editMode) => {
      const { w, s, draft, instance, task } = await scene(`ack-${editMode}`, editMode);
      await w.publishedProcess({
        nodes: [{ key: 'transfer', approver: { type: 'department', value: 'latest_record_department_head' } }],
      });
      await w.submit(
        await w.application(s.subject.employeeId, { departmentId: s.to }, { effectiveDate: '2026-10-20' }),
      );
      const action = editMode === 'separate' ? 'edit' : 'approve';
      const fields = { lastWorkDate: '2026-10-29' };
      const denied = await w.taskAction(s.outHead.userId, task.id, action, instance.revision, { fields });
      expect(denied.status, await denied.clone().text()).toBe(409);
      const rejection = await denied.json();
      expect(rejection.error.details.reason).toBe('EXIT_PENDING_TRANSFER_ACK_REQUIRED');
      expect((await w.detail(instance.id)).revision).toBe(instance.revision);
      const ok = await w.taskAction(s.outHead.userId, task.id, action, instance.revision, {
        fields,
        exitReschedule: { pendingTransferAck: rejection.error.details.ackToken },
      });
      expect(ok.status, await ok.clone().text()).toBe(200);
      expect(await w.business(draft.id)).toMatchObject({ effectiveDate: '2026-10-30' });
    },
  );
});

/**
 * R2-T03 B2b：离职 confirmed 阶段与审批适配（设计 §3.1 / §5.5 / §6-2 / §9；D-13）。
 * ① 直接离职保存、申请最后节点通过即进入 confirmed 阶段：exit_requests.pre_release_date = R（租户今天，DEC-266①），
 *   exit_effects 记 establishment_pre_released（phase confirmed），审计 exit.establishment.pre_released；仍不落地（§18.1）。
 * ② 审批适配器 exitMetadata：离职扩展字段进审批表单值与变化字段；审批编辑可补齐离职类型，补齐后最后节点同意通过。
 * ③ D-13：已生效离职的审批详情带原定 / 实际生效日。④ notifyMessage：审批模块站内消息原语（被作废申请的通知，B3-2 调用）。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { PRESET_PROCESSES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { ADAPTERS } from '../../apps/api/src/modules/approval/adapters.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { approvalWorld, transferScene } from './AC-APV-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { gateWorld, leaveBody, type GateWorld } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const LATER = '2026-10-20';

const effectsOf = (w: GateWorld, businessId: string) =>
  w.sqlRows<{ phase: string; kind: string; target_type: string; detail: Record<string, unknown> }>(sql`
    SELECT phase, kind, target_type, detail FROM exit_effects
    WHERE tenant_id=${w.session.tenant.id} AND business_id=${businessId}::uuid`);

const auditsOf = (w: GateWorld, businessId: string, action: string) =>
  w.sqlRows<{ after: Record<string, unknown> }>(sql`SELECT after FROM audit_events
    WHERE tenant_id=${w.session.tenant.id} AND action=${action} AND object_id=${businessId}`);

describe('confirmed 阶段：编制预减时点 R 与预减台账（DEC-266①）', () => {
  it('直接离职保存：R = 今天，一条 establishment_pre_released；不落地；重复读取不追加', async () => {
    const w = await gateWorld(database().db, 'confirm-direct', { today: TODAY });
    const { employee } = await w.hired();
    const created = await w.createdLeave(employee.id, leaveBody(LATER, 'direct'));
    expect(created.status).toBe('approved');
    expect(await w.exitRow(created.id)).toMatchObject({ pre_release_date: TODAY });
    expect(await effectsOf(w, created.id)).toEqual([
      {
        phase: 'confirmed',
        kind: 'establishment_pre_released',
        target_type: 'establishment-capacity',
        detail: {
          departmentId: w.from.id,
          positionId: null,
          capacityId: null,
          releasedFrom: TODAY,
          plannedEffectiveDate: '2026-10-21',
        },
      },
    ]);
    expect(await auditsOf(w, created.id, 'exit.establishment.pre_released')).toMatchObject([
      { after: { preReleaseDate: TODAY } },
    ]);
    expect((await w.stateOf(employee.id)).timeline).toHaveLength(1);
  });

  it('申请：提交时不预减；最后节点通过当日写 R；被驳回 / 草稿不写', async () => {
    const w = await gateWorld(database().db, 'confirm-approve', { today: TODAY });
    const { employee } = await w.hired();
    const draft = await w.createdLeave(employee.id, leaveBody(LATER, 'application', { exitTypeCode: 'voluntary' }));
    const sent = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(sent.status).toBe(200);
    expect(await effectsOf(w, draft.id)).toEqual([]);
    expect(await w.exitRow(draft.id)).toMatchObject({ pre_release_date: null });
    expect(await w.approve(draft, '2026-10-08T02:00:00Z')).toMatchObject({ status: 'approved' });
    expect(await w.exitRow(draft.id)).toMatchObject({ pre_release_date: '2026-10-08' });
    expect(await effectsOf(w, draft.id)).toMatchObject([
      { phase: 'confirmed', kind: 'establishment_pre_released', detail: { releasedFrom: '2026-10-08' } },
    ]);
  });
});

describe('审批适配：exitMetadata、LEAVE_FORM、审批编辑补齐离职类型', () => {
  it('预置离职流程节点表单含离职扩展字段；快照值与变化字段带离职类型 / 原因 / 去向', async () => {
    const preset = PRESET_PROCESSES.find((process) => process.presetKey === 'standard_leave')!;
    for (const node of preset.definition.nodes as unknown as {
      formFields: string[];
      actions: { avoidSelf: boolean };
    }[]) {
      expect(node.formFields).toEqual(expect.arrayContaining(['exitTypeCode', 'reasonCode', 'whereaboutsCode']));
      expect(node.actions.avoidSelf).toBe(true);
    }
    const w = await gateWorld(database().db, 'confirm-snapshot', { today: TODAY });
    const { employee } = await w.hired();
    const exit = { exitTypeCode: 'voluntary', reasonCode: 'personal', compensationAmount: 300 };
    const draft = await w.createdLeave(employee.id, leaveBody(LATER, 'application', exit));
    const snapshot = await withTenant(w.db, w.session.tenant.id, (tx) =>
      ADAPTERS.employment.snapshot(
        tx,
        {
          tenantId: w.session.tenant.id,
          userId: w.session.user.id,
          timezone: w.session.tenant.timezone,
          now: new Date(`${TODAY}T02:00:00Z`),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        draft.id,
      ),
    );
    expect(snapshot.values).toMatchObject({
      exitTypeCode: 'voluntary',
      reasonCode: 'personal',
      compensationAmount: '300.00',
    });
    expect(snapshot.changedFields).toEqual(
      expect.arrayContaining(['exitTypeCode', 'reasonCode', 'compensationAmount']),
    );
    expect(snapshot.changedFields).not.toContain('whereaboutsCode');
  });

  it('审批编辑补齐离职类型：写入扩展行并记 exit.request.update；之后最后节点同意通过', async () => {
    const w = await approvalWorld(database().db, 'confirm-edit');
    const s = await transferScene(w);
    await installExitSeeds(w.db, w.tenant.id);
    await w.publishedProcess({
      approvalType: 'leave',
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }] },
      nodes: [
        {
          key: 'out_head',
          approver: 'latest_record_department_head',
          formFields: ['lastWorkDate', 'effectiveDate', 'exitTypeCode'],
          editableFields: ['exitTypeCode'],
          editMode: 'separate',
        },
      ],
    });
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
    );
    const draft = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
        ifMatch: employee.revision,
        body: { kind: 'leave', mode: 'application', lastWorkDate: LATER, fields: {} },
      }),
      201,
    );
    const instance = await w.submit(draft);
    const task = w.pending(instance)[0]!;
    const missing = await w.taskAction(s.outHead.userId, task.id, 'approve', instance.revision);
    expect(missing.status).toBe(409);
    const edited = await w.taskAction(s.outHead.userId, task.id, 'edit', instance.revision, {
      fields: { exitTypeCode: 'involuntary' },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const [row] = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ exit_type_code: string }>(
        await tx.execute(sql`SELECT exit_type_code FROM exit_requests WHERE tenant_id=${w.tenant.id}
          AND business_id=${draft.id}::uuid`),
      ),
    );
    expect(row?.exit_type_code).toBe('involuntary');
    const after = await w.detail(instance.id);
    const ok = await w.taskAction(s.outHead.userId, task.id, 'approve', after.revision);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.business(draft.id)).toMatchObject({ status: 'approved' });
  });
});

describe('D-13 与 notifyMessage', () => {
  it('已生效离职的审批快照带原定 / 实际生效日（与调动同一函数）', async () => {
    const w = await gateWorld(database().db, 'confirm-dates', { today: TODAY });
    const { employee } = await w.hired();
    const leave = await w.effectiveExit(employee.id);
    const snapshot = await withTenant(w.db, w.session.tenant.id, (tx) =>
      ADAPTERS.employment.snapshot(
        tx,
        {
          tenantId: w.session.tenant.id,
          userId: w.session.user.id,
          timezone: w.session.tenant.timezone,
          now: new Date(`${TODAY}T02:00:00Z`),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        leave.id,
      ),
    );
    expect(snapshot.values).toMatchObject({ originalEffectiveDate: '2026-10-02', actualEffectiveDate: '2026-10-02' });
  });

  it('notifyMessage 给实例登记一条站内消息（kind message、inbox、模板编码）；接收人无账号不发', async () => {
    const w = await gateWorld(database().db, 'confirm-notify', { today: TODAY });
    const { employee } = await w.hired();
    const draft = await w.createdLeave(employee.id, leaveBody(LATER, 'application', { exitTypeCode: 'voluntary' }));
    await w.session.request('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision, body: {} });
    const [instance] = await w.sqlRows<{ id: string }>(sql`SELECT id FROM approval_instances
      WHERE tenant_id=${w.session.tenant.id} AND business_id=${draft.id}::uuid`);
    const notifications = await import('../../apps/api/src/modules/approval/notifications.js');
    const notifyMessage = (notifications as Record<string, unknown>).notifyMessage as
      ((...args: unknown[]) => Promise<void>) | undefined;
    expect(typeof notifyMessage).toBe('function');
    const ctx = {
      tenantId: w.session.tenant.id,
      userId: w.session.user.id,
      timezone: w.session.tenant.timezone,
      now: new Date(`${TODAY}T02:00:00Z`),
      commandId: randomUUID(),
      expectedRevision: 0,
    };
    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      await notifyMessage!(tx, ctx, instance!, {
        recipientUserId: w.session.user.id,
        templateCode: 'application_voided_by_exit',
      });
      await notifyMessage!(tx, ctx, instance!, {
        recipientUserId: randomUUID(),
        templateCode: 'application_voided_by_exit',
      });
    });
    const rows = await w.sqlRows(sql`SELECT kind, channel, template_code, task_id, recipient_user_id
      FROM approval_notifications WHERE tenant_id=${w.session.tenant.id} AND instance_id=${instance!.id}::uuid
        AND kind='message'`);
    expect(rows).toEqual([
      {
        kind: 'message',
        channel: 'inbox',
        template_code: 'application_voided_by_exit',
        task_id: null,
        recipient_user_id: w.session.user.id,
      },
    ]);
  });
});

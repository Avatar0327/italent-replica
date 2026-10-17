/**
 * R2-T03 B2a / AC-DM-32 B-80：B2a 合并后到 B3-3 合并前的“只允许审批、禁止离职生效”五个关口（设计 §18.1）。
 * 五例各读前后的时间轴、合同、调动申请、审批实例（stateOf 逐项相等）：
 * ① 调度 / HR 待办队列看不到离职；② 审批通过且 E ≤ 今天停在 approved；③ 直接离职 L 已过也只存 approved；
 * ④ 重试与通用 activate 409 EXIT_ACTIVATION_NOT_AVAILABLE；⑤ dutyTransfer 400 EXIT_DUTY_TRANSFER_NOT_AVAILABLE。
 * 另：approved / effective 离职的通用 DELETE / revoke 在 B4 前一律 409 EXIT_OPERATION_NOT_AVAILABLE。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { pendingActivations } from '../../apps/api/src/modules/employment/activation-store.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { queueContext } from './AC-EXIT-queue-support.js';
import { addedRows, diffRows, expectChanges, gateWorld, leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
/** 直接离职创建一次产生的 outbox 事件（按 event_type 排序；B2b 起保存即 confirmed 阶段，多一条预减审计）。 */
const OUTBOX_DIRECT = [
  'employment.business.create',
  'employment.business.state.approved',
  'exit.establishment.pre_released',
  'exit.request.create',
];
/** confirmed 阶段（B2b，设计 §3.1 / §6-2）只写编制预减台账一行，不写其他效果。 */
const preReleased = (businessId: string, releasedFrom: string) => [
  { business_id: businessId, phase: 'confirmed', kind: 'establishment_pre_released', detail: { releasedFrom } },
];

async function world(label: string) {
  const w = await gateWorld(database().db, label, { today: TODAY });
  const { employee } = await w.hired();
  return { w, employee };
}

describe('AC-DM-32 B-80 §18.1 五个关口（B3-3 前离职一律不落地）', () => {
  it('③ 直接离职 L 已过：保存为 approved，时间轴 / 合同 / 调动申请不变，无生效尝试', async () => {
    const { w, employee } = await world('closure-direct');
    const before = await w.stateOf(employee.id);
    const created = await w.createdLeave(employee.id, leaveBody('2026-10-01', 'direct'));
    expect(created.status).toBe('approved');
    const after = await w.stateOf(employee.id);
    // 创建本身会变的对象各带断言（新增行与内容、既有行原样保留）；其余（时间轴、合同、审批实例 / 日志、生效尝试）
    // 整份逐项相等；exit_effects 只多 confirmed 阶段的预减台账
    expectChanges(before, after, {
      businesses: (b, a) => expect(addedRows(b, a)).toMatchObject([{ id: created.id, state: 'approved' }]),
      exits: (b, a) => expect(addedRows(b, a)).toMatchObject([{ business_id: created.id, mode: 'direct' }]),
      effects: (b, a) => expect(addedRows(b, a)).toMatchObject(preReleased(created.id, TODAY)),
      audits: (b, a) =>
        expect(addedRows(b, a).map((row) => row.action)).toEqual([
          'employment.business.create',
          'employment.business.state.approved',
          'exit.establishment.pre_released',
          'exit.request.create',
        ]),
      ledger: (b, a) =>
        expect(addedRows(b, a)).toMatchObject([
          { response_status: 201, command_type: 'POST /api/tenant/employment/employees/:id/businesses' },
        ]),
      outboxEvents: (b, a) => {
        const added = addedRows(b, a);
        expect(added.map((row) => row.event_type)).toEqual(OUTBOX_DIRECT);
        expect(added.every((row) => row.business_id === created.id)).toBe(true);
      },
      outbox: (b, a) => expect(Number(a[0]!.n) - Number(b[0]!.n)).toBe(OUTBOX_DIRECT.length),
    });
    expect((await w.session.records(employee.id, '2026-10-10')).map((r) => r.kind)).toEqual(['hire']);
    expect(await w.exitRow(created.id)).toMatchObject({ mode: 'direct', initiator: 'hr', pre_release_date: TODAY });
  });

  it('② 审批通过且 E ≤ 今天：停在 approved，不落地、不记生效尝试；① 调度运行后仍 approved 且不在队列', async () => {
    const { w, employee } = await world('closure-approve');
    const draft = await w.createdLeave(
      employee.id,
      leaveBody('2026-10-01', 'application', { exitTypeCode: 'voluntary' }),
    );
    const sent = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(sent.status).toBe(200);
    const before = await w.stateOf(employee.id);
    expect(await w.approve(draft, `${TODAY}T02:00:00Z`)).toMatchObject({ status: 'approved' });
    const after = await w.stateOf(employee.id);
    // 审批通过走可信端口 transitions.approve：推进业务头 / 状态事件，进入 confirmed 阶段（扩展行写 R、预减台账一行），
    // 审计 / outbox 各两条、台账一条；审批实例与日志不由本端口改动，和时间轴、合同、生效尝试一起整份逐项相等
    expectChanges(before, after, {
      exits: (b, a) => {
        const [change] = diffRows(b, a, 'business_id').changed;
        expect(change?.after).toMatchObject({ business_id: draft.id, pre_release_date: TODAY });
        expect({ ...change!.after, pre_release_date: null }).toEqual(change!.before);
      },
      effects: (b, a) => expect(addedRows(b, a)).toMatchObject(preReleased(draft.id, TODAY)),
      businesses: (b, a) => {
        const diff = diffRows(b, a, 'id');
        expect([diff.added, diff.removed]).toEqual([[], []]);
        // 计数列在 PGlite 是 number、真 PG 是 bigint 字符串，统一转 number 比较
        const [change] = diff.changed;
        expect(diff.changed).toHaveLength(1);
        expect(change!.before).toMatchObject({ id: draft.id, state: 'in_review', revision: 2 });
        expect(change!.after).toMatchObject({ id: draft.id, state: 'approved', revision: 3 });
        expect(Number(change!.after.events)).toBe(Number(change!.before.events) + 1);
        expect(Number(change!.after.versions)).toBe(Number(change!.before.versions));
      },
      audits: (b, a) =>
        expect(addedRows(b, a)).toMatchObject([
          { action: 'employment.business.state.approved', object_id: draft.id },
          { action: 'exit.establishment.pre_released', object_id: draft.id },
        ]),
      ledger: (b, a) => expect(addedRows(b, a)).toMatchObject([{ response_status: 200 }]),
      outboxEvents: (b, a) =>
        expect(addedRows(b, a)).toMatchObject([
          {
            business_id: draft.id,
            event_type: 'employment.business.state.approved',
            payload: { before: { state: 'in_review' }, after: { state: 'approved' } },
          },
          { business_id: draft.id, event_type: 'exit.establishment.pre_released' },
        ]),
      outbox: (b, a) => expect(Number(a[0]!.n) - Number(b[0]!.n)).toBe(2),
    });
    const queue = await withTenant(w.db, w.session.tenant.id, (tx) =>
      pendingActivations(tx, queueContext(w, '2026-10-18'), employee.id),
    );
    expect(queue).toEqual([]);
    expect(await w.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ activated: [], failed: [], suspended: [] });
    expect(await w.stateOf(employee.id)).toEqual(after);
    expect((await w.business(draft.id)).status).toBe('approved');
  });

  it('④ HR 重试与通用 activate 端口对离职 409 EXIT_ACTIVATION_NOT_AVAILABLE，无写入', async () => {
    const { w, employee } = await world('closure-activate');
    const direct = await w.createdLeave(employee.id, leaveBody('2026-10-01', 'direct'));
    const before = await w.stateOf(employee.id);
    const retry = await w.session.request('POST', `/businesses/${direct.id}/activation/retry`, {
      ifMatch: direct.revision,
      body: {},
    });
    expect(await w.reason(retry)).toMatchObject({ status: 409, reason: 'EXIT_ACTIVATION_NOT_AVAILABLE' });
    await expect(
      runEmploymentTransition(
        w.db,
        {
          tenantId: w.session.tenant.id,
          userId: w.session.user.id,
          timezone: w.session.tenant.timezone,
          now: new Date('2026-10-18T01:00:00Z'),
          commandId: randomUUID(),
          expectedRevision: direct.revision,
        },
        { id: direct.id, action: 'activate' },
      ),
    ).rejects.toMatchObject({ details: { reason: 'EXIT_ACTIVATION_NOT_AVAILABLE' } });
    expect(await w.stateOf(employee.id)).toEqual(before);
  });

  it('⑤ 携带 dutyTransfer 的离职请求 400 EXIT_DUTY_TRANSFER_NOT_AVAILABLE，无写入', async () => {
    const { w, employee } = await world('closure-duty');
    const before = await w.stateOf(employee.id);
    const body = leaveBody('2026-10-20', 'application', { dutyTransfer: { subordinates: [], orgRoles: [] } });
    const rejected = await w.createLeave(employee.id, body);
    expect(await w.reason(rejected)).toMatchObject({ status: 400, reason: 'EXIT_DUTY_TRANSFER_NOT_AVAILABLE' });
    expect(await w.stateOf(employee.id)).toEqual(before);
  });

  it('B4 前 approved 离职的通用 DELETE / revoke 409 EXIT_OPERATION_NOT_AVAILABLE，无写入', async () => {
    const { w, employee } = await world('closure-cancel');
    const direct = await w.createdLeave(employee.id, leaveBody('2026-10-20', 'direct'));
    const before = await w.stateOf(employee.id);
    const removed = await w.session.request('DELETE', `/businesses/${direct.id}`, { ifMatch: direct.revision });
    expect(await w.reason(removed)).toMatchObject({ status: 409, reason: 'EXIT_OPERATION_NOT_AVAILABLE' });
    const revoked = await w.session.request('POST', `/businesses/${direct.id}/revoke`, {
      ifMatch: direct.revision,
      body: {},
    });
    expect(await w.reason(revoked)).toMatchObject({ status: 409, reason: 'EXIT_OPERATION_NOT_AVAILABLE' });
    expect(await w.stateOf(employee.id)).toEqual(before);
  });
});

/**
 * F-241 第 3 轮审查回归（DEC-626 超限单）：
 * - 未完整确认单生效成功时，差异审计的 after.ids 必须等于实际作废集合（含草稿等不在确认清单 S 里的申请）；
 * - 提交时确认清单已降为空 / 非空：超限标记与 warning 按本次计算结果刷新，不沿用旧标记；
 * - 仍超限时各入口（专用 / 通用 / 编辑 / 撤回重提 / 批量）保留标记；迟到生效被拒时顺延与全部业务效果一并回滚。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld, type DownstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const LAST_WORK_DATE = '2026-10-20';
const MARKER = { ids: [], hash: '', overLimit: true };
const WARNING = [{ reason: 'EXIT_APPLICATIONS_TOO_MANY', limit: 1000 }];

type Json = { id: string; revision: number; warnings?: unknown[]; error?: { details: Record<string, string> } };

async function world(label: string) {
  const x = await downstreamWorld(database().db, label, '2026-10-06');
  await x.bulkDrafts(1001, x.employee.id, { kind: 'transfer', state: 'in_review', effectiveDate: '2026-10-10' });
  return x;
}

/** 把在途调动批量改成已作废，只留 keep 条（模拟 HR 处理掉多余的申请）。 */
const settle = (x: DownstreamWorld, keep: number) =>
  x.sqlRows(sql`
    INSERT INTO employment_state_events(tenant_id, employee_id, business_id, payload_version_id, state, event_no,
      command_id)
    SELECT s.tenant_id, s.employee_id, s.business_id, s.payload_version_id, 'voided', s.event_no + 1, 'f241-settle'
    FROM (SELECT * FROM employment_state_events WHERE tenant_id=${x.session.tenant.id}
        AND employee_id=${x.employee.id}::uuid AND state='in_review' ORDER BY business_id OFFSET ${keep}) s`);

async function create(x: DownstreamWorld, mode: 'application' | 'direct' = 'application', dedicated = false) {
  const employee = await x.session.getEmployee(x.employee.id);
  const response = dedicated
    ? await x.session.request('POST', `/exits/employees/${x.employee.id}`, {
        ifMatch: employee.revision,
        body: { mode, lastWorkDate: LAST_WORK_DATE, fields: {}, exit: { exitTypeCode: 'voluntary' } },
      })
    : await x.createLeave(x.employee.id, leaveBody(LAST_WORK_DATE, mode, { exitTypeCode: 'voluntary' }));
  expect(response.status, await response.clone().text()).toBe(201);
  const body = (await response.json()) as Json;
  expect(body.warnings).toEqual(WARNING);
  return body;
}

async function call(x: DownstreamWorld, method: string, path: string, business: Json, body: object, status = 200) {
  const response = await x.session.request(method, path, { ifMatch: business.revision, body });
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as Json;
}

describe('F-241 第 3 轮：差异审计 = 实际作废集合', () => {
  it('含真实调动草稿：after.ids 等于 application_voided effects 的目标集合', async () => {
    const x = await world('r3-audit-real-draft');
    const draft = await x.transferIn('draft', '2026-10-25');
    const leave = await create(x, 'direct');
    await settle(x, 3);
    expect(await x.activate(leave.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    const voided = (await x.effects(leave.id))
      .filter((effect) => effect.kind === 'application_voided')
      .map((effect) => effect.target_id)
      .sort();
    const [audit] = await x.audits(leave.id, 'employment.exit.ack_set_changed');
    expect(voided).toContain(draft.id);
    expect(audit!.before).toEqual({ ids: [], incomplete: true });
    expect([...(audit!.after as { ids: string[] }).ids].sort()).toEqual(voided);
  }, 600_000);

  it('迟到生效仍超限被拒：顺延与业务效果整体回滚；降为空后成功，审计记空集合', async () => {
    const x = await world('r3-late-rollback');
    const leave = await create(x, 'direct');
    const before = await x.stateOf(x.employee.id);
    const versions = await x.versions(leave.id);
    expect(await x.activate(leave.id, '2026-10-22')).toMatchObject({
      outcome: 'failed',
      reason: 'EXIT_APPLICATIONS_TOO_MANY',
    });
    const after = await x.stateOf(x.employee.id);
    for (const key of ['timeline', 'exits', 'contracts', 'instances', 'effects', 'approvalLogs'] as const)
      expect(after[key], key).toEqual(before[key]);
    expect(await x.versions(leave.id)).toEqual(versions);
    // 唯一新增的 outbox 事件是失败尝试自己的 employment.activation.failed，业务效果事件一条都没有
    const known = new Set(before.outboxEvents.map((event) => JSON.stringify(event)));
    expect(
      after.outboxEvents.filter((event) => !known.has(JSON.stringify(event))).map((event) => event.event_type),
    ).toEqual(['employment.activation.failed']);
    expect(await x.audits(leave.id, 'employment.exit.ack_set_changed')).toEqual([]);
    await settle(x, 0);
    expect(await x.activate(leave.id, '2026-10-22')).toMatchObject({ outcome: 'effective' });
    expect(await x.audits(leave.id, 'employment.exit.ack_set_changed')).toEqual([
      { before: { ids: [], incomplete: true }, after: { ids: [], lastWorkDate: '2026-10-21' } },
    ]);
  }, 600_000);
});

describe('F-241 第 3 轮：提交时按本次计算结果刷新标记与 warning', () => {
  it('超限 → S 降为空 → 提交 200：无 warning，标记已清', async () => {
    const x = await world('r3-refresh-empty');
    const draft = await create(x);
    await settle(x, 0);
    const submitted = await call(x, 'POST', `/exits/${draft.id}/submit`, draft, {});
    expect(submitted.warnings).toBeUndefined();
    expect((await x.exitRow(draft.id))!.pending_transfer_ack ?? null).toBeNull();
  }, 600_000);

  it('超限 → S 降为非空：空令牌 / 错令牌 409 要求确认，带正确令牌提交后标记换成完整确认记录', async () => {
    const x = await world('r3-refresh-nonempty');
    const draft = await create(x);
    await settle(x, 3);
    let token = '';
    for (const body of [{}, { pendingTransferAck: '' }, { pendingTransferAck: 'bad' }]) {
      const response = await x.session.request('POST', `/exits/${draft.id}/submit`, {
        ifMatch: draft.revision,
        body,
      });
      expect(response.status).toBe(409);
      const details = ((await response.json()) as Json).error!.details;
      expect(details['reason']).toBe('EXIT_PENDING_TRANSFER_ACK_REQUIRED');
      token = details['ackToken']!;
    }
    const done = await call(x, 'POST', `/businesses/${draft.id}/submit`, draft, { pendingTransferAck: token });
    expect(done.warnings).toBeUndefined();
    const stored = (await x.exitRow(draft.id))!.pending_transfer_ack as { hash: string; overLimit?: true };
    expect(stored.hash).toBe(token);
    expect(stored.overLimit).toBeUndefined();
  }, 600_000);

  it('仍超限：专用创建 → 通用提交 → 撤回 → 编辑 → 专用重提，标记与 warning 一路保留', async () => {
    const x = await world('r3-still-over');
    let business = await create(x, 'application', true);
    business = await call(x, 'POST', `/businesses/${business.id}/submit`, business, {});
    expect(business.warnings).toEqual(WARNING);
    business = await call(x, 'POST', `/exits/${business.id}/withdraw`, business, {});
    business = await call(x, 'PATCH', `/exits/${business.id}`, business, { exitTypeCode: 'voluntary' });
    expect((await x.exitRow(business.id))!.pending_transfer_ack).toEqual(MARKER);
    const again = await call(x, 'POST', `/exits/${business.id}/submit`, business, {});
    expect(again.warnings).toEqual(WARNING);
  }, 600_000);

  it('批量创建：逐条带 warning，标记已存', async () => {
    const x = await world('r3-batch');
    const employee = await x.session.getEmployee(x.employee.id);
    const response = await x.session.request('POST', '/exits/batch', {
      ifMatch: 0,
      body: {
        items: [
          {
            employeeId: x.employee.id,
            revision: employee.revision,
            lastWorkDate: LAST_WORK_DATE,
            exit: { exitTypeCode: 'voluntary' },
          },
        ],
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { items } = (await response.json()) as { items: Json[] };
    expect(items[0]!.warnings).toEqual(WARNING);
    expect((await x.exitRow(items[0]!.id))!.pending_transfer_ack).toEqual(MARKER);
  }, 600_000);
});

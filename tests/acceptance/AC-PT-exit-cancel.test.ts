/**
 * BE-7 PT-6b 撤销离职下游清单的兼职项（docs/08_设计/R2-T05_兼职设计.md §4.6 / §4.9 / §13.1，R2-T03 B4 的 registerDownstreamProbe）：
 * 兼职模块登记 kind = 'part-time' 探针，撤销清单（四类固定之后）列出两类目标 ——
 *   ① 被该离职结束的兼职（期限 source = exit、source_id = 离职记录；detail 带原结束日 → L′）；
 *   ② 被该离职作废、需重新发起的兼职申请（reason = exit）。
 * 撤销后行为不变：不自动恢复兼职、不复活作废的申请（§4.6）。覆盖 PB-61 的 `exits/:id/cancel` 变体（撤销后 B-2 边界解除，
 * HR 编辑结束日恢复成功）、清单按查看人裁剪（DEC-177，不可见只计 hiddenCount，可见目标不回传 employeeId / departmentId）。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { cancelWorld, type CancelWorld } from './AC-EXIT-cancel-support.js';
import { VOID_LIMIT } from '../../apps/api/src/modules/employment/exit-void-applications.js';
import { probeDownstream, trimDownstream } from '../../apps/api/src/modules/employment/exit-downstream.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { insertPartTimeRequest } from './AC-PT-support.js';
import { orgScope } from './support/revocable-rights.js';

const database = useTestDb();
const TODAY = '2026-10-06';
/** 最后工作日 L = 10-10，离职生效日 E = 10-11（到 E 才落地），兼职被结束于 L′ = 10-10。 */
const LAST_DAY = '2026-10-10';

interface Target {
  type: string;
  id: string;
  detail?: Record<string, unknown>;
}

/** 在职员工 + 兼职部门；离职经内部编排器在 E 落地（状态钩子随之结束兼职、作废申请）。 */
async function partTimeExitWorld(label: string) {
  const x = await cancelWorld(database().db, label, TODAY);
  const partTimeOrg = await x.session.org('兼职部门', { establishedOn: '2025-01-01' });
  const tenantId = x.session.tenant.id;

  async function makePartTime(endDate: string | null) {
    const response = await x.session.request('POST', `/employees/${x.employee.id}/part-times`, {
      body: {
        partTimeType: 'part_time',
        startDate: '2026-09-01',
        ...(endDate ? { endDate } : {}),
        fields: { departmentId: partTimeOrg.id },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  }
  const draftRequest = () =>
    withTenant(x.db, tenantId, (tx) =>
      insertPartTimeRequest(tx, {
        tenantId,
        employeeId: x.employee.id,
        initiatorUserId: x.session.user.id,
        departmentId: partTimeOrg.id,
        requestType: 'add',
        state: 'draft',
      }),
    );
  const terms = (recordId: string) =>
    x.sqlRows<{ end_date: string | null; source: string; source_id: string | null }>(sql`
      SELECT end_date::text, source, source_id::text FROM employment_part_time_terms
      WHERE tenant_id=${tenantId} AND record_id=${recordId}::uuid ORDER BY term_no`);
  const requestStates = (requestId: string) =>
    x.sqlRows<{ state: string; reason: string | null }>(sql`
      SELECT state, reason FROM part_time_request_events
      WHERE tenant_id=${tenantId} AND request_id=${requestId}::uuid ORDER BY event_no`);
  /** 离职落地：直接离职停在 approved，编排器在 E 落地。 */
  async function effectiveExit() {
    const leave = await x.directLeave(LAST_DAY);
    await x.activate(leave.id, '2026-10-11');
    return leave;
  }
  const record = async (id: string) => {
    const response = await x.session.request('GET', `/part-times/${id}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { revision: number };
  };
  const edit = (id: string, endDate: string, revision: number) =>
    x.session.request('PATCH', `/part-times/${id}`, { ifMatch: revision, body: { endDate } });
  return { ...x, partTimeOrg, makePartTime, draftRequest, terms, requestStates, effectiveExit, record, edit };
}
type World = Awaited<ReturnType<typeof partTimeExitWorld>>;

const partTimeItem = (result: Awaited<ReturnType<CancelWorld['cancelled']>>) =>
  result.downstream.items.find((entry) => entry.kind === 'part-time')! as { status: string; hiddenCount: number } & {
    targets: Target[];
  };

describe('PT-6b 撤销离职清单列出兼职项 + PB-61 撤销变体', () => {
  it('撤销已生效离职：part-time 类目排在固定四类之后，列出被结束的兼职（原结束日 → L′）与被作废的申请；不自动恢复、不复活', async () => {
    const x = await partTimeExitWorld('pt6b-cancel-lists');
    const closed = await x.makePartTime('2026-10-31');
    const open = await x.makePartTime(null);
    const requestId = await x.draftRequest();
    const exit = await x.effectiveExit();
    const chains = async () => [await x.terms(closed.id), await x.terms(open.id)];
    const afterExit = await chains();
    expect(afterExit).toEqual([
      [
        { end_date: '2026-10-31', source: 'create', source_id: null },
        { end_date: LAST_DAY, source: 'exit', source_id: exit.id },
      ],
      [
        { end_date: null, source: 'create', source_id: null },
        { end_date: LAST_DAY, source: 'exit', source_id: exit.id },
      ],
    ]);
    expect((await x.requestStates(requestId)).at(-1)).toEqual({ state: 'voided', reason: 'exit' });

    const result = await x.cancelled(exit.id);

    expect(result.downstream.items.map((entry) => entry.kind)).toEqual([
      'contract',
      'duty_transfer',
      'handover',
      'payroll',
      'part-time',
    ]);
    const item = partTimeItem(result);
    expect(item).toMatchObject({ status: 'found', hiddenCount: 0 });
    const records = item.targets.filter((target) => target.type === 'employment-record');
    expect(records).toHaveLength(2);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: closed.id,
          detail: expect.objectContaining({ originalEndDate: '2026-10-31', endDate: LAST_DAY }),
        }),
        expect.objectContaining({
          id: open.id,
          detail: expect.objectContaining({ originalEndDate: null, endDate: LAST_DAY }),
        }),
      ]),
    );
    expect(item.targets.filter((target) => target.type === 'part-time-request')).toEqual([
      { type: 'part-time-request', id: requestId, detail: expect.objectContaining({ reason: 'exit' }) },
    ]);
    for (const target of item.targets) expect(Object.keys(target).sort()).toEqual(['detail', 'id', 'type']);

    // §4.6：撤销不改兼职期限链，不复活作废的申请
    expect(await chains()).toEqual(afterExit);
    expect((await x.requestStates(requestId)).at(-1)).toEqual({ state: 'voided', reason: 'exit' });
    // 撤销记录保存的清单与回执同源
    expect((await x.cancellationOf(exit.id))!.downstream.items.map((entry) => entry.kind)).toContain('part-time');
  });

  it('PB-61（exits/:id/cancel 变体）：撤销离职后 B-2 边界解除，编辑结束日为 10-31 成功；撤销前同样的编辑被拒', async () => {
    const x = await partTimeExitWorld('pt6b-pb61');
    const part = await x.makePartTime(null);
    const exit = await x.effectiveExit();
    const { revision } = await x.record(part.id);
    const refused = await x.edit(part.id, '2026-10-31', revision);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toContain('PART_TIME_BEYOND_EXIT');
    const before = await x.terms(part.id);

    await x.cancelled(exit.id);
    expect(await x.terms(part.id)).toEqual(before);

    const restored = await x.edit(part.id, '2026-10-31', revision);
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect((await x.terms(part.id)).map((term) => term.source)).toEqual(['create', 'exit', 'edit']);
  });

  it('没有受离职影响的兼职与申请：part-time 类目 status = none，目标为空', async () => {
    const x = await partTimeExitWorld('pt6b-none');
    const exit = await x.effectiveExit();
    expect(partTimeItem(await x.cancelled(exit.id))).toEqual({
      kind: 'part-time',
      status: 'none',
      targets: [],
      hiddenCount: 0,
    });
  });

  it('未生效的离职（已批准、未落地）撤销：没有任何兼职被结束，类目 none', async () => {
    const x = await partTimeExitWorld('pt6b-not-effective');
    await x.makePartTime('2026-10-31');
    const leave = await x.directLeave(LAST_DAY);
    expect(partTimeItem(await x.cancelled(leave.id))).toMatchObject({ status: 'none', targets: [], hiddenCount: 0 });
  });

  it('只列本次离职的结果：先前已撤销的另一次离职结束的兼职、作废的申请不入第二次的清单', async () => {
    const x = await partTimeExitWorld('pt6b-only-this-exit');
    const part = await x.makePartTime(null);
    const firstRequest = await x.draftRequest();
    const first = await x.effectiveExit();
    await x.cancelled(first.id);
    const { revision } = await x.record(part.id);
    expect((await x.edit(part.id, '2026-10-31', revision)).status).toBe(200);
    const secondRequest = await x.draftRequest();

    const second = await x.directLeave('2026-10-20');
    await x.activate(second.id, '2026-10-21');
    const item = partTimeItem(await x.cancelled(second.id));

    expect(item.targets.map((target) => [target.type, target.id])).toEqual([
      ['employment-record', part.id],
      ['part-time-request', secondRequest],
    ]);
    expect(item.targets[0]!.detail).toMatchObject({ originalEndDate: '2026-10-31', endDate: '2026-10-20' });
    expect(item.targets.map((target) => target.id)).not.toContain(firstRequest);
  });
});

describe('PT-6b 清单按查看人裁剪（DEC-177，失败即关）', () => {
  async function setup(label: string) {
    const x = await partTimeExitWorld(label);
    const record = await x.makePartTime('2026-10-31');
    const requestId = await x.draftRequest();
    const exit = await x.effectiveExit();
    return { x, record, requestId, exit };
  }
  const trimmed = (x: World, exitId: string, scope: ModuleScope) =>
    withTenant(x.db, x.session.tenant.id, async (tx) => {
      const ctx: EmploymentContext = {
        tenantId: x.session.tenant.id,
        userId: x.session.user.id,
        timezone: x.session.tenant.timezone,
        now: new Date(`${TODAY}T01:00:00Z`),
        commandId: randomUUID(),
        expectedRevision: 0,
        scope,
      };
      const input = { employeeId: x.employee.id, lastWorkDate: LAST_DAY, businessId: exitId };
      const raw = await probeDownstream(tx, ctx, input);
      return (await trimDownstream(tx, ctx, raw, x.employee.id)).items.find((entry) => entry.kind === 'part-time')!;
    });

  it('范围里没有兼职部门也没有员工当前部门 / 空范围：目标不回传，只计 hiddenCount（记录 1 + 申请 1）', async () => {
    const { x, exit } = await setup('pt6b-trim-hidden');
    for (const scope of [EMPTY_SCOPE, orgScope(x.session.tenant.id, TODAY, randomUUID())])
      expect(await trimmed(x, exit.id, scope)).toMatchObject({ status: 'found', targets: [], hiddenCount: 2 });
  });

  it('范围覆盖兼职部门：记录与申请都可见（按兼职部门判定），不回传 employeeId / departmentId', async () => {
    const { x, record, requestId, exit } = await setup('pt6b-trim-visible');
    const item = await trimmed(x, exit.id, orgScope(x.session.tenant.id, TODAY, x.partTimeOrg.id));
    expect(item.hiddenCount).toBe(0);
    expect(item.targets.map((target) => target.id).sort()).toEqual([record.id, requestId].sort());
    for (const target of item.targets) expect(Object.keys(target).sort()).toEqual(['detail', 'id', 'type']);
  });
});

describe('PT-6b 第 1 轮 P2-1：撤销已提交后响应投影不得因目标过多返回 413', () => {
  // 恰为作废上限的待作废任职申请（1000）+ 1 条兼职：清单聚合出 1001 个任职范围目标，超过 disclose 的单次上限；
  // 响应投影发生在撤销提交之后，413 会让“已撤销”的请求失败。首次撤销与同键重放都必须成功，清单完整。
  it('1000 条被作废的任职申请 + 1 条兼职：首次撤销与同键重放都 200，清单完整（1000 + 1）', async () => {
    const x = await partTimeExitWorld('pt6b-many-targets');
    const part = await x.makePartTime('2026-10-31');
    await x.bulkDrafts(VOID_LIMIT);
    const exit = await x.effectiveExit();
    const body = { reason: '录入有误' };
    const key = 'pt6b-many-targets-cancel';

    const ifMatch = (await x.business(exit.id)).revision;
    const first = await x.cancel(exit.id, body, { idempotencyKey: key, ifMatch });
    expect(first.status, await first.clone().text()).toBe(200);
    const result = (await first.json()) as Awaited<ReturnType<CancelWorld['cancelled']>>;
    const voided = result.downstream.additional.find((entry) => entry.kind === 'application_voided')!;
    expect(voided.targets).toHaveLength(VOID_LIMIT);
    expect(voided.hiddenCount).toBe(0);
    expect(partTimeItem(result).targets.map((target) => target.id)).toEqual([part.id]);
    expect(await x.stateOfBusiness(exit.id)).toBe('deleted');

    const replay = await x.cancel(exit.id, body, { idempotencyKey: key, ifMatch });
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(result);
  }, 600_000);
});

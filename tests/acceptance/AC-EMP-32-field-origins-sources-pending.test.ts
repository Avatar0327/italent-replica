/**
 * AC-EMP-32（F-036-S5 第 3 轮，设计 §4.9）：
 *  - 来源业务 ID 必须与“直接读那张来源单”走同一个可见性决定，不借目标单的同单例外、不丢来源自己的已办内容；
 *  - `pending` 取“来源业务是否已落地、字段是否已物化进任职记录”的事实，不看载荷版本是不是记录快照。
 * 全部走真实业务入口造数；期望值手写。
 */
import { runEmploymentActivations } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { APPROVAL_TYPES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons, gateWorld } from './AC-EXIT-gate-support.js';
import { BASE, adjustmentOf, bodyOf, hrDraft, managerWorld, rename, type OriginField } from './AC-EMP-30-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import { cmd } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const STANDARD = 'TenantBase.CrossDepartmentTransferMultiFormView';
const READABLE_FIELDS = ['id', 'employeeId', 'kind', 'effectiveDate', 'status', 'revision', 'departmentId', 'place'];

interface OriginsBody {
  contentView: { mode: string };
  fields: (OriginField & { policy: string | null; pending: boolean })[];
}

describe('AC-EMP-32 来源 ID 与“直接读来源单”同一个可见性决定', () => {
  it('① 仅有「使用用户」范围的 HR：入职单详情与来源均 404，借 Switch 31 读调动申请的来源得 200，但入职单 ID 为空', async () => {
    const g = await gateWorld(database().db, `emp32-hr-${uniqueSuffix()}`, { today: '2026-10-06' });
    const settings = await g.session.request('PUT', '/transfers/settings', {
      ifMatch: 0,
      body: { unrestrictTargetDepartment: true, autoPopulate: true },
    });
    expect(settings.status, await settings.clone().text()).toBe(200);
    const restrictedHr = await g.otherUser();
    // 员工档案由受限 HR 创建（使用用户坐标 = 受限 HR）；入职单与调动申请由主 HR 创建（创建人坐标 = 主 HR）
    const created = await g.employeeAs(restrictedHr.id, '受限HR名下的员工');
    const employee = await g.session.getEmployee(created.id);
    const hire = await g.session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: g.from.id, place: '原地点' },
      },
      employee.revision,
    );
    const afterHire = await g.session.getEmployee(employee.id);
    const applied = await g.session.request('POST', `/transfers/employees/${employee.id}`, {
      ifMatch: afterHire.revision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        formId: STANDARD,
        effectiveDate: '2026-10-20',
        mode: 'application',
        fields: { departmentId: g.to.id },
      },
    });
    expect(applied.status, await applied.clone().text()).toBe(201);
    const application = (await applied.json()) as { id: string };
    // 补录入职记录的工作地：向后更新到调动申请
    const current = await g.business(hire.id);
    const patched = await g.session.request('PATCH', `/records/${hire.id}`, {
      ifMatch: current.revision,
      body: { fields: { place: 'ZZ_补录工作地' } },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);

    const read = g.restricted(denyButtons(), restrictedHr.id, READABLE_FIELDS);
    const status = async (path: string) => (await read('GET', path)).status;
    expect(await status(`/businesses/${hire.id}`), '前提：入职单详情对受限 HR 不可见').toBe(404);
    expect(await status(`/businesses/${hire.id}/field-origins`), '前提：入职单来源对受限 HR 不可见').toBe(404);
    expect(await status(`/businesses/${application.id}`), '前提：Switch 31 同单例外使调动申请可读').toBe(200);

    const response = await read('GET', `/businesses/${application.id}/field-origins`);
    expect(response.status, await response.clone().text()).toBe(200);
    const text = await response.text();
    const place = (JSON.parse(text) as OriginsBody).fields.find((row) => row.fieldCode === 'preset:place');
    expect(place, '前提：工作地由补录入职记录向后更新而来').toMatchObject({
      value: 'ZZ_补录工作地',
      origin: { kind: 'forward-update' },
    });
    expect(place?.origin?.sourceBusinessId).toBeNull();
    expect(text, '响应体里不得出现入职单 ID').not.toContain(hire.id);
  });

  it('② 经理已办过的非团队成员调动（详情 200 / 已办内容）：组织调整记录的 copy 来源保留该调动的 ID', async () => {
    const x = await managerWorld(database().db);
    const { w } = x;
    await w.publishedProcess({
      approvalType: 'transfer',
      conditions: {
        items: [{ no: 1, field: 'processCode', operator: 'eq', value: APPROVAL_TYPES.transfer.defaultProcessCode }],
      },
      nodes: [
        {
          key: 'review',
          name: '审核',
          approver: { type: 'specified', value: x.manager.userId },
          formFields: ['effectiveDate', 'departmentId', 'place'],
        },
      ],
    });
    // 非团队成员（在范围内非团队组织）的调动，由经理审批通过，到生效日落地
    const draft = await hrDraft(
      w,
      x.stranger.employeeId,
      { departmentId: x.outside, place: 'ZZ_已办调动地' },
      '2026-10-05',
    );
    const submitted = await w.submit({ id: draft.id, revision: 1 });
    const task = w.pending(submitted)[0]!;
    const approved = await w.taskAction(x.manager.userId, task.id, 'approve', submitted.revision, { comment: '同意' });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const run = await runEmploymentActivations(
      w.db,
      cmd(),
      { tenantId: w.tenant.id },
      { clock: () => new Date('2026-10-06T01:00:00.000Z') },
    );
    expect(run.runs[0]?.activated.length, JSON.stringify(run)).toBeGreaterThan(0);
    // 组织改名联动生成复制该调动的任职记录
    w.setNow('2026-10-10T01:00:00Z');
    await rename(w, x.outside);
    const adjustment = await adjustmentOf(w, x.stranger.employeeId);

    const detail = await bodyOf(await x.read(`${BASE}/businesses/${draft.id}`));
    expect(detail.status, '前提：经理读自己已办的调动详情').toBe(200);
    expect((detail.body as unknown as { contentView: { mode: string } }).contentView.mode).not.toBe('live');
    const own = await x.read(`${BASE}/businesses/${draft.id}/field-origins`);
    expect(own.status, '前提：经理读自己已办的调动来源').toBe(200);

    const response = await x.read(`${BASE}/businesses/${adjustment.id}/field-origins`);
    expect(response.status, await response.clone().text()).toBe(200);
    const place = ((await response.json()) as OriginsBody).fields.find((row) => row.fieldCode === 'preset:place');
    expect(place).toMatchObject({ value: 'ZZ_已办调动地', origin: { kind: 'copy', sourceBusinessId: draft.id } });
  });
});

describe('AC-EMP-32 pending 取落地与物化的事实', () => {
  async function pendingWorld(today: string) {
    const w = await activationWorld(database().db, `emp32-pending-${uniqueSuffix()}`, { today });
    const configured = await w.session.request('PUT', '/transfers/settings', {
      ifMatch: 0,
      body: { unrestrictTargetDepartment: false, autoPopulate: false },
    });
    expect(configured.status, await configured.clone().text()).toBe(200);
    const person = await w.hired();
    const directOn = (effectiveDate: string) =>
      w.session.business(
        person.employee.id,
        { kind: 'transfer', mode: 'direct', effectiveDate, fields: { departmentId: w.to.id } },
        person.hire.employeeRevision,
      );
    const origins = async (id: string) => {
      const response = await w.session.request('GET', `/businesses/${id}/field-origins`);
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as OriginsBody).fields;
    };
    const payloads = (id: string) =>
      withTenant(w.db, w.session.tenant.id, async (tx) =>
        resultRows<{ version: number; snapshot: boolean }>(
          await tx.execute(sql`SELECT version_no AS version, is_record_snapshot AS snapshot
            FROM employment_payload_versions WHERE tenant_id = ${w.session.tenant.id}
              AND business_id = ${id}::uuid ORDER BY version_no`),
        ),
      );
    return { w, person, directOn, origins, payloads };
  }

  const pendingOf = (rows: OriginsBody['fields']) => rows.filter((row) => row.pending).map((row) => row.fieldCode);
  const deferredCount = (rows: OriginsBody['fields']) => rows.filter((row) => row.policy === 'deferred').length;

  it('当天生效的直接调动：落地后没有待解析字段（载荷仍只有首版、不是记录快照）', async () => {
    const x = await pendingWorld('2026-10-05');
    const transfer = await x.directOn('2026-10-05');
    const rows = await x.origins(transfer.id);
    expect(deferredCount(rows), '前提：关闭自动带出后存在延迟继承字段').toBeGreaterThan(0);
    expect(await x.payloads(transfer.id)).toEqual([{ version: 1, snapshot: false }]);
    expect(pendingOf(rows)).toEqual([]);
  });

  it('按时调度落地（审批通过的申请，生效日当天由定时任务生效）：落地前有待解析字段，落地后没有', async () => {
    const x = await pendingWorld('2026-10-01');
    const employee = await x.w.hired('按时落地员工');
    const application = await x.w.apply(employee.employee.id, '2026-10-05', { departmentId: x.w.to.id });
    await x.w.approve(application, '2026-10-02T01:00:00Z');
    expect(pendingOf(await x.origins(application.id)).length, '前提：落地前存在待解析字段').toBeGreaterThan(0);
    const run = await x.w.runScheduler('2026-10-05T01:00:00Z');
    expect(run).toMatchObject({ failed: [], errors: [] });
    x.w.session.setNow('2026-10-05T01:00:00Z'); // 定时任务入口自带时钟，读接口的时钟要同步推进
    const after = await x.origins(application.id);
    expect(deferredCount(after)).toBeGreaterThan(0);
    expect(await x.payloads(application.id)).toEqual([{ version: 1, snapshot: false }]);
    expect(pendingOf(after)).toEqual([]);
  });

  it('迟到顺延落地（生效日之后才运行定时任务）：落地后没有待解析字段', async () => {
    const x = await pendingWorld('2026-10-01');
    const employee = await x.w.hired('迟到落地员工');
    const application = await x.w.apply(employee.employee.id, '2026-10-05', { departmentId: x.w.to.id });
    await x.w.approve(application, '2026-10-02T01:00:00Z');
    const run = await x.w.runScheduler('2026-10-06T01:00:00Z');
    expect(run).toMatchObject({ failed: [], errors: [] });
    x.w.session.setNow('2026-10-06T01:00:00Z');
    const after = await x.origins(application.id);
    expect(deferredCount(after)).toBeGreaterThan(0);
    expect(pendingOf(after)).toEqual([]);
  });

  it('生效日前补录前驱的工作地：给调动追加记录快照，被触碰的工作地有来源，没碰的延迟字段仍待解析', async () => {
    const x = await pendingWorld('2026-10-01');
    const transfer = await x.directOn('2026-10-05');
    const untouched = pendingOf(await x.origins(transfer.id)).filter((code) => code !== 'preset:place');
    expect(untouched.length, '前提：除工作地外还有待解析字段').toBeGreaterThan(0);
    const hire = await x.w.business(x.person.hire.id);
    const patched = await x.w.session.request('PATCH', `/records/${x.person.hire.id}`, {
      ifMatch: hire.revision,
      body: { fields: { place: 'ZZ_补录工作地' } },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect((await x.payloads(transfer.id)).at(-1), '前提：向后更新给调动追加了记录快照').toEqual({
      version: 2,
      snapshot: true,
    });

    const after = await x.origins(transfer.id);
    const row = (code: string) => after.find((entry) => entry.fieldCode === code);
    expect(row('preset:place')).toMatchObject({
      value: 'ZZ_补录工作地',
      origin: { kind: 'forward-update' },
      pending: false,
    });
    expect(pendingOf(after).sort()).toEqual([...untouched].sort());
  });
});

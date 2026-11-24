/**
 * AC-EMP-32（F-036-S5 第 3 轮，设计 §4.9）：
 *  - 来源业务 ID 必须与“直接读那张来源单”走同一个可见性决定，不借目标单的同单例外、不丢来源自己的已办内容；
 *  - `pending` 取“来源业务是否已落地、字段是否已物化进任职记录”的事实，不看载荷版本是不是记录快照。
 * 全部走真实业务入口造数；期望值手写。
 */
import './support/exit-gate-enforced.js';
import { runEmploymentActivations } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { APPROVAL_TYPES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { denyButtons, gateWorld } from './AC-EXIT-gate-support.js';
import { BASE, adjustmentOf, bodyOf, hrDraft, managerWorld, rename, type OriginField } from './AC-EMP-30-support.js';
import { type EmploymentSession } from './AC-EMP-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { exitActivationWorld } from './AC-EXIT-activation-support.js';
import { cancelWorld as exitCancelWorld } from './AC-EXIT-cancel-support.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import { retirementCancelWorld } from './AC-RT-cancel-support.js';
import { dedicatedBody, retireBody, retirementWorld } from './AC-RT-support.js';
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

  // 第 6 轮路径矩阵行 5：同日移位（timeline.ts shiftSameDay 先删后插）只改 sort_order，start_date 原样写回
  it('迟到落地插到已有直接调动的同一天之前：同日移位后两单生效日不变，工作地都不 pending', async () => {
    const x = await pendingWorld('2026-10-01');
    const employee = await x.w.hired('同日移位员工');
    const current = await x.w.session.getEmployee(employee.employee.id);
    const direct = await x.w.session.business(
      employee.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-06', fields: { departmentId: x.w.to.id } },
      current.revision,
    );
    const application = await x.w.apply(employee.employee.id, '2026-10-05', { departmentId: x.w.to.id });
    await x.w.approve(application, '2026-10-02T01:00:00Z');
    const run = await x.w.runScheduler('2026-10-06T01:00:00Z');
    expect(run).toMatchObject({ failed: [], errors: [] });
    const sameDay = await withTenant(x.w.db, x.w.session.tenant.id, async (tx) =>
      resultRows<{ id: string; order: number }>(
        await tx.execute(sql`SELECT record_id::text AS id, sort_order AS order FROM employment_timeline
          WHERE tenant_id = ${x.w.session.tenant.id} AND start_date = '2026-10-06' ORDER BY sort_order`),
      ),
    );
    expect(sameDay, '前提：迟到的申请排到直接调动之前，直接调动被同日移位').toEqual([
      { id: application.id, order: 0 },
      { id: direct.id, order: 1 },
    ]);
    for (const day of ['2026-10-06', '2026-10-09']) {
      x.w.session.setNow(`${day}T01:00:00Z`);
      for (const id of [application.id, direct.id]) {
        const rows = await x.origins(id);
        expect(deferredCount(rows), `${day} ${id}`).toBeGreaterThan(0);
        expect(pendingOf(rows), `${day} ${id}`).toEqual([]);
      }
    }
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

describe('AC-EMP-32 pending：未落地的业务一律仍待解析（第 4 轮，设计 §4.9 “尚未落地解析”）', () => {
  async function closedAutoPopulate(world: { session: EmploymentSession }) {
    const configured = await world.session.request('PUT', '/transfers/settings', {
      ifMatch: 0,
      body: { unrestrictTargetDepartment: false, autoPopulate: false },
    });
    expect(configured.status, await configured.clone().text()).toBe(200);
  }
  const originsAt = async (world: { session: EmploymentSession }, id: string, day: string) => {
    world.session.setNow(`${day}T01:00:00Z`);
    const response = await world.session.request('GET', `/businesses/${id}/field-origins`);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as OriginsBody).fields;
  };
  const pendingCodes = (rows: OriginsBody['fields']) => rows.filter((row) => row.pending).map((row) => row.fieldCode);

  it('离职作废的未来直接调动：原计划日前后读来源接口，工作地都仍是 pending（作废的业务从未落地）', async () => {
    const x = await exitActivationWorld(database().db, `emp32-voided-${uniqueSuffix()}`, '2026-10-06');
    await closedAutoPopulate(x);
    const employee = await x.session.getEmployee(x.employee.id);
    const transfer = await x.session.business(
      x.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-25', fields: { departmentId: x.to.id } },
      employee.revision,
    );
    const leave = await x.directLeave('2026-10-20');
    expect(await x.activate(leave.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    expect(await x.stateOfBusiness(transfer.id), '前提：离职生效把未来调动作废').toBe('voided');
    expect(await x.timeline(), '前提：作废的调动不在时间轴上').toHaveLength(2);

    for (const day of ['2026-10-24', '2026-10-25', '2026-10-26']) {
      const rows = await originsAt(x, transfer.id, day);
      const place = rows.find((row) => row.fieldCode === 'preset:place');
      expect(place, day).toMatchObject({ policy: 'deferred', origin: null, pending: true });
      expect(pendingCodes(rows), day).toContain('preset:place');
    }
  });

  async function unlandedWorld(label: string) {
    const x = await activationWorld(database().db, `emp32-unlanded-${label}-${uniqueSuffix()}`, {
      today: '2026-10-01',
    });
    await closedAutoPopulate(x);
    const person = await x.hired(`${label}员工`);
    const application = await x.apply(person.employee.id, '2026-10-05', { departmentId: x.to.id });
    return { x, person, application };
  }
  const transition = async (
    x: Awaited<ReturnType<typeof unlandedWorld>>['x'],
    id: string,
    action: 'reject' | 'approve',
    at: string,
  ) => {
    const { runEmploymentTransition } = await import('../../apps/api/src/modules/employment/transitions.js');
    const current = await x.business(id);
    const result = await runEmploymentTransition(
      x.db,
      {
        tenantId: x.session.tenant.id,
        userId: x.session.user.id,
        timezone: x.session.tenant.timezone,
        now: new Date(at),
        commandId: randomUUID(),
        expectedRevision: current.revision,
      },
      { id, action },
    );
    expect(result.status).toBe(200);
  };

  it.each([
    ['撤回', 'withdraw'],
    ['撤销', 'revoke'],
  ] as const)('申请被%s：生效日当天与之后都没有落地，工作地仍 pending', async (_name, action) => {
    const { x, application } = await unlandedWorld(action);
    const current = await x.business(application.id);
    const response = await x.session.request('POST', `/businesses/${application.id}/${action}`, {
      ifMatch: current.revision,
      body: {},
    });
    expect(response.status, await response.clone().text()).toBe(200);
    for (const day of ['2026-10-04', '2026-10-05', '2026-10-08']) {
      expect(pendingCodes(await originsAt(x, application.id, day)), day).toContain('preset:place');
    }
  });

  it('申请被驳回：生效日当天与之后都没有落地，工作地仍 pending', async () => {
    const { x, application } = await unlandedWorld('reject');
    await transition(x, application.id, 'reject', '2026-10-02T01:00:00Z');
    for (const day of ['2026-10-04', '2026-10-05', '2026-10-08']) {
      expect(pendingCodes(await originsAt(x, application.id, day)), day).toContain('preset:place');
    }
  });

  it('改期后仍待前序（调度因前序区间含本单记需重建，未落地）：生效日之后工作地仍 pending', async () => {
    const x = await activationWorld(database().db, `emp32-resched-${uniqueSuffix()}`, { today: '2026-10-01' });
    await closedAutoPopulate(x);
    const person = await x.hired('改期员工');
    const approve = async (date: string, at: string) =>
      x.approve(await x.apply(person.employee.id, date, { departmentId: x.to.id }), at);
    const earlier = await approve('2026-10-05', '2026-10-01T02:00:00Z');
    const later = await approve('2026-10-06', '2026-10-08T01:00:00Z');
    // 调度前先读真正被改期的后单：它是 approved、生效日已被改到审批当天，工作地仍待解析
    const rescheduled = await x.business(later.id);
    expect(rescheduled, '前提：后单已审批通过、尚未落地').toMatchObject({ status: 'approved' });
    expect(rescheduled.effectiveDate, '前提：后单的生效日已因迟到审批而改期').not.toBe('2026-10-06');
    expect(pendingCodes(await originsAt(x, later.id, '2026-10-08')), '后单（调度前）').toContain('preset:place');
    const run = await x.runScheduler('2026-10-09T01:00:00Z');
    expect(run, '前提：前序记需重建而没有落地').toMatchObject({ failed: [earlier.id] });
    for (const day of ['2026-10-09', '2026-10-12']) {
      expect(pendingCodes(await originsAt(x, earlier.id, day)), day).toContain('preset:place');
    }
  });
});

describe('AC-EMP-32 pending：曾落地的业务被摘出时间轴后仍是已落地（第 5 轮，设计 §4.9）', () => {
  async function retiringWorld(label: string) {
    const x = await retirementWorld(database().db, `emp32-${label}-${uniqueSuffix()}`, '2026-10-06');
    const configured = await x.session.request('PUT', '/transfers/settings', {
      ifMatch: 0,
      body: { unrestrictTargetDepartment: false, autoPopulate: false },
    });
    expect(configured.status, await configured.clone().text()).toBe(200);
    const transferOn = async (effectiveDate: string) => {
      const { revision } = await x.session.getEmployee(x.employee.id);
      const transfer = await x.session.business(
        x.employee.id,
        { kind: 'transfer', mode: 'direct', effectiveDate, fields: { departmentId: x.to.id } },
        revision,
      );
      expect(transfer.status).toBe('effective');
      return transfer;
    };
    const retire = async (lastWorkDate: string) => {
      const { revision } = await x.session.getEmployee(x.employee.id);
      const response = await x.session.request('POST', `/retirements/employees/${x.employee.id}`, {
        ifMatch: revision,
        body: dedicatedBody(lastWorkDate, 'direct'),
      });
      expect(response.status, await response.clone().text()).toBe(201);
    };
    const originsOn = async (id: string, day: string) => {
      x.session.setNow(`${day}T01:00:00Z`);
      const response = await x.session.request('GET', `/businesses/${id}/field-origins`);
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as OriginsBody).fields;
    };
    return { x, transferOn, retire, originsOn };
  }
  const placeOf = (rows: OriginsBody['fields']) => rows.find((row) => row.fieldCode === 'preset:place');

  it('当天已落地的调动被退休顺延重排摘出时间轴：此前实际生效过，工作地不再 pending', async () => {
    const { x, transferOn, retire, originsOn } = await retiringWorld('retire-sameday');
    const transfer = await transferOn('2026-10-06');
    expect(placeOf(await originsOn(transfer.id, '2026-10-06')), '前提：摘出前已落地').toMatchObject({
      policy: 'deferred',
      pending: false,
    });
    x.session.setNow('2026-10-06T01:00:00Z');
    await retire('2026-10-04');
    expect(
      (await x.timeline()).map((row) => row.kind),
      '前提：调动已被摘出时间轴',
    ).toEqual(['hire', 'retirement']);
    for (const day of ['2026-10-06', '2026-10-07', '2026-10-20']) {
      expect(placeOf(await originsOn(transfer.id, day)), day).toMatchObject({ policy: 'deferred', pending: false });
    }
  });

  it('未来调动被退休提前摘出：原计划日前后都没有实际生效，工作地仍 pending', async () => {
    const { x, transferOn, retire, originsOn } = await retiringWorld('retire-future');
    const transfer = await transferOn('2026-10-20');
    await retire('2026-10-05');
    expect(
      (await x.timeline()).map((row) => row.kind),
      '前提：调动已被摘出时间轴',
    ).toEqual(['hire', 'retirement']);
    for (const day of ['2026-10-19', '2026-10-20', '2026-10-25']) {
      expect(placeOf(await originsOn(transfer.id, day)), day).toMatchObject({ policy: 'deferred', pending: true });
    }
  });

  it('直接办理的未来调动：生效日前 pending，生效日当天起不再 pending（时间轴条目的生效日已到）', async () => {
    const { transferOn, originsOn } = await retiringWorld('direct-future');
    const transfer = await transferOn('2026-10-20');
    expect(placeOf(await originsOn(transfer.id, '2026-10-19')), '前一天').toMatchObject({ pending: true });
    expect(placeOf(await originsOn(transfer.id, '2026-10-20')), '生效日').toMatchObject({ pending: false });
  });

  it('仍在时间轴上的未来调动在生效日前被 HR 删除：从未实际生效，原计划日之后工作地仍 pending', async () => {
    const { x, transferOn, originsOn } = await retiringWorld('delete-future');
    const transfer = await transferOn('2026-10-20');
    x.session.setNow('2026-10-06T02:00:00Z');
    const current = await x.business(transfer.id);
    const deleted = await x.session.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: current.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    for (const day of ['2026-10-07', '2026-10-21'])
      expect(placeOf(await originsOn(transfer.id, day)), day).toMatchObject({ policy: 'deferred', pending: true });
  });

  it('已落地（当天生效）的调动被 HR 删除：此前实际生效过，工作地不再 pending', async () => {
    const { x, transferOn, originsOn } = await retiringWorld('delete-landed');
    const transfer = await transferOn('2026-10-06');
    expect(placeOf(await originsOn(transfer.id, '2026-10-06')), '前提：删除前已落地').toMatchObject({ pending: false });
    x.session.setNow('2026-10-06T02:00:00Z');
    const current = await x.business(transfer.id);
    const deleted = await x.session.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: current.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await x.timeline(), '前提：调动已不在时间轴上').toHaveLength(1);
    expect(placeOf(await originsOn(transfer.id, '2026-10-07')), '删除后').toMatchObject({ pending: false });
  });
});

describe('AC-EMP-32 pending：摘下后挂回 / 删除（第 5 轮路径矩阵）', () => {
  async function cancelWorld(label: string) {
    const x = await retirementCancelWorld(database().db, `emp32-${label}-${uniqueSuffix()}`, '2026-10-06');
    const configured = await x.session.request('PUT', '/transfers/settings', {
      ifMatch: 0,
      body: { unrestrictTargetDepartment: false, autoPopulate: false },
    });
    expect(configured.status, await configured.clone().text()).toBe(200);
    const employee = await x.session.getEmployee(x.employee.id);
    const transfer = await x.session.business(
      x.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-25', fields: { departmentId: x.to.id } },
      employee.revision,
    );
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    expect(retire.status).toBe('effective');
    const originsStatus = async (day: string) => {
      x.session.setNow(`${day}T01:00:00Z`);
      const response = await x.session.request('GET', `/businesses/${transfer.id}/field-origins`);
      const body = response.status === 200 ? ((await response.json()) as OriginsBody) : null;
      return { status: response.status, place: body?.fields.find((row) => row.fieldCode === 'preset:place') };
    };
    return { x, transfer, retire, originsStatus };
  }

  it('撤销退休把被摘下的未来调动挂回：生效日前仍 pending，生效日起不再 pending', async () => {
    const { x, retire, originsStatus } = await cancelWorld('reattach');
    expect(await originsStatus('2026-10-24'), '摘下期间').toMatchObject({ status: 200, place: { pending: true } });
    x.session.setNow('2026-10-06T01:00:00Z');
    await x.retireCancelled(retire.id, {});
    expect(await originsStatus('2026-10-24'), '挂回后生效日前').toMatchObject({
      status: 200,
      place: { pending: true },
    });
    expect(await originsStatus('2026-10-25'), '挂回后生效日').toMatchObject({ status: 200, place: { pending: false } });
  });

  it('第 6 轮：撤销退休挂回、到期后再被 HR 删除：此前实际生效过，工作地仍不 pending', async () => {
    const { x, transfer, retire, originsStatus } = await cancelWorld('reattach-delete');
    x.session.setNow('2026-10-06T01:00:00Z');
    await x.retireCancelled(retire.id, {});
    expect(await originsStatus('2026-10-26'), '前提：挂回后到期').toMatchObject({
      status: 200,
      place: { policy: 'deferred', pending: false },
    });
    x.session.setNow('2026-10-26T02:00:00Z');
    const current = await x.business(transfer.id);
    const deleted = await x.session.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: current.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(
      (await x.timeline()).map((row) => row.kind),
      '前提：调动已不在时间轴上',
    ).toEqual(['hire']);
    for (const day of ['2026-10-27', '2026-11-10'])
      expect(await originsStatus(day), `删除后 ${day}`).toMatchObject({ status: 200, place: { pending: false } });
  });

  it('撤销退休挂回后、到期前被离职作废：从未实际生效，原计划日之后工作地仍 pending', async () => {
    const { x, transfer, retire, originsStatus } = await cancelWorld('reattach-void');
    x.session.setNow('2026-10-06T01:00:00Z');
    await x.retireCancelled(retire.id, {});
    const leave = await x.directLeave('2026-10-15');
    expect(await x.runScheduler('2026-10-16T02:00:00Z')).toMatchObject({ activated: [leave.id] });
    expect(await x.stateOfBusiness(transfer.id), '前提：调动已被离职作废').toBe('voided');
    expect(await originsStatus('2026-10-26')).toMatchObject({ status: 200, place: { pending: true } });
  });

  it('被退休提前摘下的调动再被 HR 删除：从未实际生效，原计划日之后工作地仍 pending', async () => {
    const { x, transfer, originsStatus } = await cancelWorld('deleted');
    x.session.setNow('2026-10-26T01:00:00Z');
    const current = await x.business(transfer.id);
    const deleted = await x.session.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: current.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await originsStatus('2026-10-26')).toMatchObject({ status: 200, place: { pending: true } });
  });
});

describe('AC-EMP-32 pending：已生效离职改期先挂回再重摘（第 6 轮路径矩阵，exit-reposition.ts）', () => {
  /**
   * 离职改早不能越过同周期任职记录（EXIT_RESCHEDULE_CROSSES_RECORD），所以改期能摘下的只有与原离职同日、排在它前面的调动；
   * 生效日在原离职之后的调动已在离职生效时摘下并作废（DEC-725③）。
   */
  async function leaveWorld(label: string) {
    const x = await exitCancelWorld(database().db, `emp32-${label}-${uniqueSuffix()}`);
    const configured = await x.session.request('PUT', '/transfers/settings', {
      ifMatch: 0,
      body: { unrestrictTargetDepartment: false, autoPopulate: false },
    });
    expect(configured.status, await configured.clone().text()).toBe(200);
    const sameDay = await x.directTransfer(x.to, '2026-10-21');
    const later = await x.directTransfer(x.other, '2026-10-25');
    const leave = await x.directLeave('2026-10-20');
    expect(await x.runScheduler('2026-10-21T02:00:00Z')).toMatchObject({ activated: [leave.id] });
    let minute = 0;
    const reschedule = async (lastWorkDate: string) => {
      x.setNow(`2026-11-05T02:${String(minute++).padStart(2, '0')}:00Z`);
      const response = await x.session.request('PATCH', `/exits/${leave.id}`, {
        ifMatch: (await x.business(leave.id)).revision,
        body: { lastWorkDate },
      });
      expect(response.status, `改期到 ${lastWorkDate}：${await response.clone().text()}`).toBe(200);
    };
    const placeOn = async (day: string) => {
      x.session.setNow(`${day}T03:00:00Z`);
      const response = await x.session.request('GET', `/businesses/${sameDay.id}/field-origins`);
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as OriginsBody).fields.find((row) => row.fieldCode === 'preset:place');
    };
    const kinds = async () => (await x.timeline()).map((row) => row.kind);
    return { x, sameDay, later, reschedule, placeOn, kinds };
  }

  it('改早越过已落地调动（摘下不作废）→ 改晚挂回（无回执）→ HR 删除：每步之后工作地都不 pending', async () => {
    const { x, sameDay, later, reschedule, placeOn, kinds } = await leaveWorld('reposition');
    expect(await x.tombstoned(later.id), '前提：原离职之后的调动已在生效时作废').toBe(true);
    expect(await placeOn('2026-11-05'), '前提：同日调动已落地').toMatchObject({ policy: 'deferred', pending: false });
    await reschedule('2026-10-05');
    expect(await kinds(), '改早后同日调动被摘下').toEqual(['hire', 'leave']);
    expect(await x.tombstoned(sameDay.id), '改期重摘不作废').toBe(false);
    expect(await placeOn('2026-11-05'), '摘下后').toMatchObject({ pending: false });
    await reschedule('2026-10-25');
    expect(await kinds(), '改晚后同日调动被挂回').toEqual(['hire', 'transfer', 'leave']);
    expect(await placeOn('2026-11-05'), '挂回后').toMatchObject({ pending: false });
    x.setNow('2026-11-05T04:00:00Z');
    const deleted = await x.session.request('DELETE', `/businesses/${sameDay.id}`, {
      ifMatch: (await x.business(sameDay.id)).revision,
    });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await placeOn('2026-11-06'), '删除后').toMatchObject({ pending: false });
  });

  it('改早摘下（不作废）后 HR 删除：只写墓碑、不在时间轴上，靠摘除台账仍判已落地', async () => {
    const { x, sameDay, reschedule, placeOn, kinds } = await leaveWorld('reposition-delete');
    await reschedule('2026-10-05');
    x.setNow('2026-11-05T04:00:00Z');
    const deleted = await x.session.request('DELETE', `/businesses/${sameDay.id}`, {
      ifMatch: (await x.business(sameDay.id)).revision,
    });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await kinds()).toEqual(['hire', 'leave']);
    expect(await placeOn('2026-11-06'), '删除后').toMatchObject({ pending: false });
  });

  /**
   * 守卫（DEC-991 已知限制，升级见 F-557）：`repositionExit` 在同一事务里先挂回、再按新位置重摘，每次都写新的摘除台账行，
   * 挂回本身不留回执。判定第 2 条把“摘下时窗口起点 ≤ 摘除当天”当作“摘下时已生效”，所以要求：离职摘除台账里没有墓碑
   * （仍可挂回）的目标，摘下时都已实际生效。当前可达路径下：改早不得越过同周期记录，只能摘下与原离职同日、已生效的调动；
   * 挂回至原离职同日后仍可再次摘除（重摘），新摘除行记的仍是该调动的真实生效日；生效前就被离职摘下的调动一律作废并写
   * 墓碑（DEC-725③）。两项各自由谁验证：
   * - 本用例验证离职一侧：若跳过离职生效时的作废，未生效的调动会留下无墓碑的摘除行，本用例在 `from <= on` 断言处变红；
   * - 退休日期不可改（DEC-636）由 AC-RT-09 单独验证；退休的提前摘除不作废，但走不到 `repositionExit`。
   * 放开退休改期，或新增可让未到期调动被摘下后再挂回 / 重摘的路径之前，须先按 F-557 升级到在场台账。
   */
  it('守卫：离职摘除台账里未作废的目标，摘下时都已实际生效', async () => {
    const { x, reschedule } = await leaveWorld('reposition-guard');
    await reschedule('2026-10-05');
    await reschedule('2026-10-25');
    const rows = await x.sqlRows<{ record: string; from: string; on: string }>(sql`
      SELECT x.target_id::text AS record, x.detail->'window'->>'from' AS "from",
        (x.created_at AT TIME ZONE ${x.session.tenant.timezone})::date::text AS "on"
      FROM exit_effects x
      WHERE x.tenant_id=${x.session.tenant.id} AND x.kind='future_transfer_detached'
        AND NOT EXISTS (SELECT 1 FROM employment_record_tombstones d
          WHERE d.tenant_id=x.tenant_id AND d.record_id=x.target_id)`);
    expect(rows.length, '前提：改期写了可挂回的摘除行').toBeGreaterThan(0);
    for (const row of rows) expect(row.from <= row.on, `${row.record} 摘下时已生效`).toBe(true);
  });
});

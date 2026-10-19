/**
 * BE-7 PT-7 兼职新增申请的联动（docs/08_设计/R2-T05_兼职设计.md §4.5 / §4.8，DEC-634，PB-57 申请侧改正例）：
 * - 申请草稿 / 修改 / 提交只保存并校验 isDepartmentHead / addedSubordinateIds，不执行联动；
 * - 审批通过落地与直接新增同一分支：开始日 ≤ 今天立即执行，未来开始写待执行事件、开始日由定时生效执行；
 * - 新增节点审批编辑开放“是否部门负责人”（DEC-634），不开新增下属（F234A C9 字段集，取最小集合）；改后按 §4.3A 重跑校验；
 * - 落地复核联动人员不合格 → 申请作废 landing_rejected，不建兼职、不改负责人 / 下属；
 * - 延长 / 结束申请只改结束日期与备注：联动字段为 true / 非空 → 400 PART_TIME_FIELD_NOT_EDITABLE。
 */
import { runEmploymentActivations } from '@italent/api';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { requestDto } from '../../apps/api/src/modules/employment/part-time/request-read.js';
import { findCurrentRecord } from '../../apps/api/src/modules/employment/read-model.js';
import { requestWorld, type RequestWorld } from './AC-PT-request-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
/**
 * 夹具的 setOrgRoles 直接插组织版本、不动对象 revision；联动走真实组织写入（版本号 = revision + 1），
 * 所以这里把兼职部门的对象 revision 对齐到已有最大版本号（可信夹具，只为让两种写法能共存）。
 */
async function world(label: string) {
  const w = await requestWorld(database().db, `lk-${label}`);
  await w.run((tx) =>
    tx.execute(sql`UPDATE org_objects SET revision=(SELECT max(version_no) FROM org_versions
      WHERE tenant_id=${w.tenant.id} AND org_id=${w.side}::uuid)
      WHERE tenant_id=${w.tenant.id} AND id=${w.side}::uuid`),
  );
  return w;
}

const headOf = (w: RequestWorld, orgId: string) =>
  w.run(async (tx) => {
    const [row] = rowsOf<{ head: string | null }>(
      await tx.execute(sql`SELECT person_in_charge_id AS head FROM org_versions
        WHERE tenant_id=${w.tenant.id} AND org_id=${orgId}::uuid ORDER BY version_no DESC LIMIT 1`),
    );
    return row!.head;
  });
const managerOf = (w: RequestWorld, employeeId: string, asOf = '2026-10-01') =>
  w.run(async (tx) => (await findCurrentRecord(tx, w.tenant.id, employeeId, asOf))!.fields.directManagerId);
/** 申请落地后的兼职记录 ID（add 申请头不带记录，落在 effective 状态事件上）。 */
const landedRecord = async (w: RequestWorld, requestId: string) =>
  (await w.states(requestId)).find((event) => event.state === 'effective')!.record_id!;
const linkEvents = (w: RequestWorld, recordId: string) =>
  w.run(async (tx) => {
    const rows = rowsOf<{ eventType: string; n: number }>(
      await tx.execute(sql`SELECT event_type AS "eventType", count(*)::int AS n FROM employment_outbox
        WHERE tenant_id=${w.tenant.id} AND object_id=${recordId}::uuid AND event_type LIKE 'employment.part_time.%link%'
        GROUP BY event_type`),
    );
    return Object.fromEntries(rows.map((row) => [row.eventType, row.n]));
  });
const sweep = (w: RequestWorld, date: string) =>
  runEmploymentActivations(w.db, cmd(), { tenantId: w.tenant.id }, { clock: () => new Date(`${date}T01:00:00.000Z`) });

describe('申请草稿：只保存、只校验，不执行联动', () => {
  it('创建 / 修改把两个字段存进申请版本；此时负责人与下属都不动', async () => {
    const w = await world('draft');
    const sub = await w.person('下属', w.primary);
    const created = await w.create({ isDepartmentHead: true, addedSubordinateIds: [sub.employeeId] });
    expect((await w.load(created.id)).version).toMatchObject({
      isDepartmentHead: true,
      addedSubordinateIds: [sub.employeeId],
    });
    // 读形状带回两个字段（落地前只是申请上的意图）
    expect(requestDto(await w.load(created.id)).fields).toMatchObject({
      isDepartmentHead: true,
      addedSubordinateIds: [sub.employeeId],
    });
    await w.update(created.id, created.revision, { isDepartmentHead: false });
    const updated = await w.load(created.id);
    expect(updated.version).toMatchObject({ versionNo: 2, isDepartmentHead: false });
    expect(updated.version.addedSubordinateIds).toEqual([sub.employeeId]);
    expect(await headOf(w, w.side)).toBe(w.approvers.sHead.employeeId);
    expect(await managerOf(w, sub.employeeId)).toBeNull();
  });

  it('联动人员不合格（本人）→ 创建当次 400，不建申请头、无审计', async () => {
    const w = await world('draft-ineligible');
    const before = await w.writes();
    const error = await w.rejected(() => w.create({ addedSubordinateIds: [w.worker.employeeId] }));
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', reason: 'TRANSFER_PERSON_NOT_ELIGIBLE' });
    expect(await w.writes()).toEqual(before);
  });
});

describe('审批通过落地：与直接新增同一分支', () => {
  it('开始日 ≤ 今天：末节点同意的同一事务里执行联动，申请 effective，兼职记录保存标志', async () => {
    const w = await world('land-now');
    const sub = await w.person('下属', w.primary);
    const created = await w.create({ isDepartmentHead: true, addedSubordinateIds: [sub.employeeId] });
    await w.send(created.id, created.revision);
    await w.approveInOrder(created.id, w.order.add);
    const landed = await w.load(created.id);
    expect(landed.state).toBe('effective');
    expect(await headOf(w, w.side)).toBe(w.worker.employeeId);
    expect(await managerOf(w, sub.employeeId)).toBe(w.worker.employeeId);
    expect(await linkEvents(w, await landedRecord(w, created.id))).toEqual({ 'employment.part_time.linked': 1 });
  });

  it('开始日 > 今天：落地只写待执行事件；开始日由定时生效执行，之后重复触发不再改', async () => {
    const w = await world('land-future');
    const created = await w.create({ startDate: '2026-10-20', isDepartmentHead: true });
    await w.send(created.id, created.revision);
    await w.approveInOrder(created.id, w.order.add);
    const recordId = await landedRecord(w, created.id);
    expect(await linkEvents(w, recordId)).toEqual({ 'employment.part_time.linkage.pending': 1 });
    expect(await headOf(w, w.side)).toBe(w.approvers.sHead.employeeId);
    expect((await sweep(w, '2026-10-19')).runs[0]!.errors).toEqual([]);
    expect(await headOf(w, w.side)).toBe(w.approvers.sHead.employeeId);
    expect((await sweep(w, '2026-10-20')).runs[0]!.errors).toEqual([]);
    expect(await headOf(w, w.side)).toBe(w.worker.employeeId);
    await sweep(w, '2026-10-21');
    expect(await linkEvents(w, recordId)).toMatchObject({ 'employment.part_time.linked': 1 });
  });

  it('落地复核联动人员已不合格（审批期间下属离职）→ 申请作废 landing_rejected，不建兼职、不改负责人', async () => {
    const w = await world('land-rejected');
    const sub = await w.person('下属', w.primary);
    const created = await w.create({ isDepartmentHead: true, addedSubordinateIds: [sub.employeeId] });
    await w.send(created.id, created.revision);
    const current = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${sub.employeeId}`),
    );
    await w.json(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${sub.employeeId}/businesses`, {
        ifMatch: current.revision,
        body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30' },
      }),
      201,
    );
    await w.approveInOrder(created.id, w.order.add);
    expect((await w.states(created.id)).map((event) => event.state)).toContain('voided');
    expect((await w.load(created.id)).recordId).toBeNull();
    expect(await headOf(w, w.side)).toBe(w.approvers.sHead.employeeId);
    expect((await w.partTimeRecords()).length).toBe(0);
  });
});

describe('新增节点审批编辑：开放“是否部门负责人”，不开新增下属', () => {
  async function scene(label: string) {
    const w = await world(`edit-${label}`);
    const created = await w.create({ endDate: null });
    await w.send(created.id, created.revision);
    const view = await w.instance(created.id);
    return { w, created, view, task: w.pending(view)[0]! };
  }
  const approveWith = (s: Awaited<ReturnType<typeof scene>>, fields: Record<string, unknown>) =>
    s.w.taskAction(s.task.assigneeUserId, s.task.id, 'approve', s.view.revision, { comment: '合成意见', fields });

  it('编辑并同意：isDepartmentHead = true 成功追加版本；全部节点同意后落地按编辑后的值执行', async () => {
    const s = await scene('head');
    const ok = await approveWith(s, { isDepartmentHead: true });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await s.w.load(s.created.id)).version).toMatchObject({ versionNo: 2, isDepartmentHead: true });
    await s.w.approveInOrder(s.created.id, s.w.order.add.slice(1));
    expect(await headOf(s.w, s.w.side)).toBe(s.w.worker.employeeId);
  });

  it('新增下属不在可编辑集合：403 APPROVAL_FIELD_NOT_EDITABLE，无写入', async () => {
    const s = await scene('subs');
    const before = { writes: await s.w.writes(), request: await s.w.load(s.created.id) };
    const response = await approveWith(s, { addedSubordinateIds: [s.w.worker.employeeId] });
    expect(response.status).toBe(403);
    expect({ writes: await s.w.writes(), request: await s.w.load(s.created.id) }).toEqual(before);
  });

  it('改后按 §4.3A 重跑校验：同一申请版本里已有不合格的下属时，审批编辑当次拒绝，版本与审批状态不变', async () => {
    const w = await world('edit-recheck');
    const sub = await w.person('下属', w.primary);
    const created = await w.create({ startDate: '2026-10-01', addedSubordinateIds: [sub.employeeId] });
    await w.send(created.id, created.revision);
    const current = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${sub.employeeId}`),
    );
    await w.json(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${sub.employeeId}/businesses`, {
        ifMatch: current.revision,
        body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30' },
      }),
      201,
    );
    const view = await w.instance(created.id);
    const task = w.pending(view)[0]!;
    const before = await w.load(created.id);
    const response = await w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
      comment: '合成意见',
      fields: { isDepartmentHead: true },
    });
    expect(response.status).toBe(400);
    expect(await w.load(created.id)).toEqual(before);
    expect(w.pending(await w.instance(created.id)).map((item) => item.id)).toEqual([task.id]);
  });
});

describe('延长 / 结束申请不带联动：只改结束日期与备注', () => {
  it.each(['extend', 'end'] as const)(
    '%s：创建带 isDepartmentHead = true / 非空 addedSubordinateIds → 400 PART_TIME_FIELD_NOT_EDITABLE，false / 空数组放行',
    async (type) => {
      const w = await world(`date-${type}`);
      const record = await w.seedRecord();
      const before = await w.writes();
      for (const extra of [{ isDepartmentHead: true }, { addedSubordinateIds: [w.worker.employeeId] }])
        expect(
          await w.rejected(() =>
            w.createDate({
              requestType: type,
              recordId: record,
              endDate: type === 'extend' ? '2026-12-31' : '2026-10-15',
              ...extra,
            }),
          ),
        ).toMatchObject({ code: 'VALIDATION_FAILED', reason: 'PART_TIME_FIELD_NOT_EDITABLE' });
      expect(await w.writes()).toEqual(before);
      const saved = await w.createDate({
        requestType: type,
        recordId: record,
        endDate: type === 'extend' ? '2026-12-31' : '2026-10-15',
        isDepartmentHead: false,
        addedSubordinateIds: [],
      });
      expect(saved.state).toBe('draft');
    },
  );
});

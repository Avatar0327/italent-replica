/**
 * AC-DM-30-12：导入离职单的列表 / 详情 / 改期 / 撤销（设计 §8.3、§10；复用 F-140，不另开导入专用逻辑）。
 * 今天 2026-11-05；H = 2023-03-01；原 L = 2025-06-30。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitPostEffectHooks } from '../../apps/api/src/modules/employment/exit-confirmation.js';
import { registerEmployeeStatusHooks } from '../../apps/api/src/modules/employment/status-hooks.js';
import { H, importWorld, type ImportWorld } from './AC-DM-30-support.js';

const database = useTestDb();
interface Listed {
  id: string;
  mode: string;
  actions: string[];
}

async function listed(x: ImportWorld, query: string) {
  const response = await x.session.request('GET', `/exits?${query}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: Listed[] }).items;
}

async function patch(x: ImportWorld, id: string, lastWorkDate: string) {
  const detail = await x.session.request('GET', `/exits/${id}`);
  expect(detail.status, await detail.clone().text()).toBe(200);
  const { revision } = (await detail.json()) as { revision: number };
  return x.session.request('PATCH', `/exits/${id}`, { ifMatch: revision, body: { lastWorkDate } });
}

const versions = (x: ImportWorld, id: string) =>
  x.q<{ versionNo: number; mode: string; manual: boolean; planned: string; effective: string; lastWorkDate: string }>(
    x.sql`SELECT version_no AS "versionNo", mode, manual_plan AS manual, planned_effective_date::text AS planned,
      effective_date::text AS effective, last_work_date::text AS "lastWorkDate"
      FROM employment_payload_versions WHERE tenant_id=${x.tenantId} AND business_id=${id}::uuid ORDER BY version_no`,
  );

async function oneImported(label: string, disableFrom?: string) {
  const x = await importWorld(database().db, `12-${label}`);
  const d = await x.dept('改期部门');
  if (disableFrom) await x.disable(d.id, disableFrom);
  const [item] = await x.rowsOfBatch(await x.imported([x.row(1, d.code)]));
  expect(item!.status).toBe('succeeded');
  return { x, d, exitBusinessId: item!.exit_business_id!, employeeId: item!.employee_id! };
}

describe('AC-DM-30-12 列表与详情', () => {
  it('已完成 / 全部能查到，发起方式显示直接离职（F-493 S3c：不再露出导入标识），按 initiation=direct 筛得出；进行中查不到；详情动作有 edit', async () => {
    const { x, exitBusinessId } = await oneImported('list');
    for (const view of ['completed', 'all'])
      expect((await listed(x, `view=${view}`)).find((item) => item.id === exitBusinessId)).toMatchObject({
        mode: 'direct',
        actions: expect.arrayContaining(['edit']),
      });
    expect((await listed(x, 'view=all&initiation=direct')).map((item) => item.id)).toContain(exitBusinessId);
    expect((await listed(x, 'view=in_progress')).map((item) => item.id)).not.toContain(exitBusinessId);
    const detail = await x.session.request('GET', `/exits/${exitBusinessId}`);
    const body = (await detail.json()) as { mode: string; actions: string[] };
    expect(body.mode).toBe('direct');
    expect(body.actions).toContain('edit');
    expect(body.actions).not.toContain('submit');
  });
});

describe('AC-DM-30-12 改期', () => {
  it('① 区间内重定位：追加 v2（载荷 mode=direct、manual_plan），时间轴同步，状态仍为 8，onEffective 0 次', async () => {
    const { x, exitBusinessId, employeeId } = await oneImported('re1');
    const rescheduled: string[] = [];
    registerEmployeeStatusHooks(`dm30-${exitBusinessId}`, {
      async onRecordRescheduled(_tx, _ctx, event) {
        if (event.after.recordId === exitBusinessId) rescheduled.push(event.after.effectiveDate);
      },
    });
    const effective: string[] = [];
    exitPostEffectHooks.onEffective(async (_tx, _ctx, event) => void effective.push(event.businessId));
    const response = await patch(x, exitBusinessId, '2025-05-31');
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await versions(x, exitBusinessId)).at(-1)).toMatchObject({
      versionNo: 2,
      mode: 'direct',
      manual: true,
      planned: '2025-06-01',
      effective: '2025-06-01',
      lastWorkDate: '2025-05-31',
    });
    const timeline = await x.timelineOf(employeeId);
    expect(timeline.map((row) => row.startDate)).toEqual([H, '2025-06-01']);
    expect(timeline[0]!.validDuring).toContain('2025-06-01');
    const [status] = await x.q<{ status: number }>(x.sql`SELECT employee_status AS status FROM employment_records
      WHERE tenant_id=${x.tenantId} AND employee_id=${employeeId}::uuid ORDER BY start_date DESC LIMIT 1`);
    expect(status?.status).toBe(8);
    expect(await x.auditCount('employment.leave.replanned')).toBe(1);
    expect(rescheduled).toEqual(['2025-06-01']);
    expect(effective).toEqual([]);
    expect(await x.exitRowOf(exitBusinessId)).toMatchObject({ mode: 'import' });
  });

  it('② 改晚仍在可用期内（部门 2025-08-01 停用，L → 2025-07-20）：计划日与实际日都是 2025-07-21', async () => {
    const { x, exitBusinessId } = await oneImported('re2', '2025-08-01');
    const response = await patch(x, exitBusinessId, '2025-07-20');
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await versions(x, exitBusinessId)).at(-1)).toMatchObject({
      planned: '2025-07-21',
      effective: '2025-07-21',
    });
  });

  it('③ 改晚进入停用期（L → 2025-09-30）：409 EMPLOYMENT_DEPARTMENT_DISABLED，版本与时间轴不变', async () => {
    const { x, exitBusinessId, employeeId } = await oneImported('re3', '2025-08-01');
    const before = [await versions(x, exitBusinessId), await x.timelineOf(employeeId)];
    const response = await patch(x, exitBusinessId, '2025-09-30');
    expect(response.status).toBe(409);
    expect((await x.errorOf(response)).details).toMatchObject({
      reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
      disabledOn: '2025-08-01',
    });
    expect([await versions(x, exitBusinessId), await x.timelineOf(employeeId)]).toEqual(before);
  });

  it('④ 新 L 早于 H：400 EXIT_LAST_WORK_DATE_BEFORE_ENTRY，不变', async () => {
    const { x, exitBusinessId } = await oneImported('re4');
    const before = await versions(x, exitBusinessId);
    const response = await patch(x, exitBusinessId, '2023-02-28');
    expect(response.status).toBe(400);
    expect((await x.errorOf(response)).details?.reason).toBe('EXIT_LAST_WORK_DATE_BEFORE_ENTRY');
    expect(await versions(x, exitBusinessId)).toEqual(before);
  });

  it('⑤ 新 L 晚于今天：前单撤销、人员恢复在职，新建 approved 后继单（mode=import），出现在进行中', async () => {
    const { x, exitBusinessId, employeeId } = await oneImported('re5');
    const response = await patch(x, exitBusinessId, '2026-11-30');
    expect(response.status, await response.clone().text()).toBe(200);
    const { successor } = (await response.json()) as { successor: { id: string; status: string } };
    expect(successor.id).not.toBe(exitBusinessId);
    expect(successor.status).toBe('approved');
    expect(await x.exitRowOf(successor.id)).toMatchObject({ mode: 'import', supersedes: exitBusinessId });
    expect((await x.statesOf(exitBusinessId)).at(-1)).not.toBe('effective');
    // 离职记录留墓碑不删行，“恢复在职”看时间轴：只剩入职段
    expect((await x.timelineOf(employeeId)).map((t) => t.startDate)).toEqual([H]);
    expect((await listed(x, 'view=in_progress')).map((item) => item.id)).toContain(successor.id);
  });

  it('⑥ 任职记录编辑入口改离职记录的日期：400 RECORD_DATE_IMMUTABLE', async () => {
    const { x, exitBusinessId } = await oneImported('re6');
    const detail = await x.session.request('GET', `/exits/${exitBusinessId}`);
    const { revision } = (await detail.json()) as { revision: number };
    const response = await x.session.request('PATCH', `/records/${exitBusinessId}`, {
      ifMatch: revision,
      body: { lastWorkDate: '2025-05-31' },
    });
    expect(response.status).toBe(400);
    expect((await x.errorOf(response)).details?.reason).toBe('RECORD_DATE_IMMUTABLE');
  });
});

describe('AC-DM-30-12 撤销', () => {
  it('撤销已生效导入离职：人员恢复在职，onCancelled 照常运行，不产生名单', async () => {
    const x = await importWorld(database().db, '12-cancel');
    const d = await x.dept('撤销部门');
    const [item] = await x.rowsOfBatch(await x.imported([x.row(1, d.code)]));
    const cancelled: string[] = [];
    exitPostEffectHooks.onCancelled(async (_tx, _ctx, event) => void cancelled.push(event.businessId));
    const detail = await x.session.request('GET', `/exits/${item!.exit_business_id}`);
    const { revision } = (await detail.json()) as { revision: number };
    const response = await x.session.request('POST', `/exits/${item!.exit_business_id}/cancel`, {
      ifMatch: revision,
      body: { reason: '合成撤销', confirmed: true },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(cancelled).toEqual([item!.exit_business_id]);
    expect((await x.timelineOf(item!.employee_id!)).map((t) => t.startDate)).toEqual([H]);
    const listed = await x.q(x.sql`SELECT 1 FROM employment_blacklist WHERE tenant_id=${x.tenantId}
      AND employee_id=${item!.employee_id!}::uuid`);
    expect(listed).toHaveLength(0);
  });
});

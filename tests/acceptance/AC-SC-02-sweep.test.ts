/** AC-SC-02 / DEC-343、429、440：真实钩子、生产者、worker 与权限投影。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { exitWorld, runner, type ExitWorld } from './AC-SC-02-support.js';
import { rowsOf } from './support/f048.js';
import { tenantApi } from './support/tenant-api.js';
import { permissionWorldOf, recordOperator } from './AC-SC-permission-support.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import type { EmploymentBusiness } from './AC-EMP-support.js';
import {
  employeeStatusHooks,
  registerEmployeeStatusHooks,
  resetEmployeeStatusHooksForTest,
} from '../../apps/api/src/modules/employment/status-hooks.js';
import { installSuccessionExitHooks, successionExitHooks } from '../../apps/api/src/modules/succession/exit-store.js';
import { runCalcPage, changeCalcRun } from '../../apps/api/src/modules/succession/calc-worker.js';
import { SUCCESSION_JOBS } from '../../apps/api/src/modules/succession/scheduler.js';
import { SUCCESSION_PRODUCERS } from '../../apps/api/src/modules/succession/calc-jobs.js';
import { SUCCESSION_CALC_KINDS } from '../../apps/api/src/modules/succession/calc-contract.js';

const testDb = useTestDb();
const before = '2026-10-01T01:00:00Z';
const due = '2026-10-02T01:00:00Z';
describe('AC-SC-02 sweep 与删除 / 撤销', () => {
  let w: ExitWorld;
  beforeAll(async () => {
    w = await exitWorld(testDb().db, 'sc-exit-sweep');
    await runner(w);
    await installApprovalFallbacks(w.db, w.tenant.id, w.user.id);
  });
  it('正式登记唯一 kind / 生产者 / 任务；未来保存不结束，到期两类候选结束并幂等', async () => {
    expect(SUCCESSION_PRODUCERS.filter((p) => p.kind === 'exit_sweep')).toHaveLength(1);
    expect(SUCCESSION_CALC_KINDS.filter((p) => p.kind === 'exit_sweep')).toHaveLength(1);
    expect(SUCCESSION_JOBS.filter((p) => p.kind === 'exit_sweep')).toHaveLength(1);
    const e = await w.hire();
    const ids = [await w.seedRecord(e.id), await w.seedRecord(e.id, 'org')];
    const leave = await w.leave(e);
    await w.sweep(before);
    for (const id of ids) expect(await w.read(id)).toMatchObject({ end_date: '9999-12-31', revision: 1 });
    await w.sweep(due);
    for (const id of ids)
      expect(await w.read(id)).toMatchObject({ end_date: '2026-10-02', end_source: 'exit', exit_record_id: leave.id });
    const snapshot = await Promise.all(ids.map(w.read));
    await w.sweep(due);
    await w.sweep('2026-10-03T01:00:00Z');
    expect(await Promise.all(ids.map(w.read))).toEqual(snapshot);
    expect((await w.apps(e.id))[0]!.ended_record_ids.sort()).toEqual(ids.sort());
    const audits = rowsOf<{ n: number }>(
      await w.asTenant((tx) =>
        tx.execute(sql`
      SELECT count(*)::int n FROM audit_events WHERE object_id=ANY(${`{${ids.join(',')}}`}::text[])
        AND action='succession.record.update'`),
      ),
    );
    expect(audits[0]!.n).toBe(2);
  });
  it('事件后新增 / 登记前已离职不补处理；已结束和已删除不改；历史离职早于开始日取零长度', async () => {
    const e = await w.hire();
    const ended = await w.seedRecord(e.id, 'position', { endDate: '2026-10-01', endSource: 'manual' });
    const deleted = await w.seedRecord(e.id, 'org', { deleted: true });
    const snapshots = await Promise.all([ended, deleted].map(w.read));
    await w.leave(e);
    const late = await w.seedRecord(e.id);
    await w.sweep('2026-10-04T01:00:00Z');
    expect(await Promise.all([ended, deleted].map(w.read))).toEqual(snapshots);
    expect(await w.read(late)).toMatchObject({ end_date: '9999-12-31', revision: 1 });
    expect((await w.apps(e.id))[0]!.candidate_record_ids).not.toContain(late);
    const historical = await w.hire();
    const zero = await w.seedRecord(historical.id, 'position', { startDate: '2026-10-03' });
    w.setNow('2026-10-04T01:00:00Z');
    await w.leave(historical);
    expect(await w.read(zero)).toMatchObject({ end_date: '2026-10-03', end_source: 'exit' });
    const old = await w.hire();
    w.setNow(due);
    // 登记前已离职：端口不补发，恢复登记后 sweep 不能扫描全任职补处理。
    resetEmployeeStatusHooksForTest();
    try {
      await w.leave(old);
    } finally {
      installSuccessionExitHooks();
    }
    const untracked = await w.seedRecord(old.id);
    await w.sweep('2026-10-05T01:00:00Z');
    expect(await w.read(untracked)).toMatchObject({ end_date: '9999-12-31', revision: 1 });
  });
  it('删除已生效离职不恢复继任；删除未来离职取消待处理候选；同命令重放不重复', async () => {
    for (const future of [false, true]) {
      const e = await w.hire();
      const id = await w.seedRecord(e.id);
      w.setNow(future ? before : due);
      const leave = await w.leave(e);
      const beforeDelete = await w.read(id);
      const options = { ifMatch: leave.revision, idempotencyKey: randomUUID() };
      const first = await w.requestEmployment('DELETE', `/businesses/${leave.id}`, options);
      expect(first.status, await first.clone().text()).toBe(200);
      expect((await w.requestEmployment('DELETE', `/businesses/${leave.id}`, options)).status).toBe(200);
      await w.sweep('2026-10-06T01:00:00Z');
      expect(await w.read(id)).toEqual(beforeDelete);
      expect(await w.apps(e.id)).toHaveLength(1);
      expect((await w.apps(e.id))[0]!.source).toBe('delete_revert');
    }
  });
  it('同日 run 不扩大冻结集合；提交后重放 worker 不重复结束；新日期处理后来候选', async () => {
    const e = await w.hire();
    const id = await w.seedRecord(e.id, 'org');
    await w.leave(e);
    const time = new Date('2026-10-07T01:00:00Z');
    const producer = SUCCESSION_PRODUCERS.find((p) => p.kind === 'exit_sweep')!;
    await w.asTenant((tx) => producer.runTenant(tx, w.tenant, time));
    const [run] = rowsOf<{ id: string }>(
      await w.asTenant((tx) =>
        tx.execute(sql`
      SELECT id FROM succession_calc_runs WHERE business_date='2026-10-07' AND kind='exit_sweep'`),
      ),
    );
    const later = await w.hire();
    const laterId = await w.seedRecord(later.id, 'org');
    await w.leave(later);
    await w.asTenant((tx) => producer.runTenant(tx, w.tenant, time));
    expect(await runCalcPage(w.db, w.tenant.id, run!.id, undefined, time)).toBe('succeeded');
    const saved = await w.read(id);
    expect(await runCalcPage(w.db, w.tenant.id, run!.id, undefined, time)).toBe('succeeded');
    expect(await w.read(id)).toEqual(saved);
    expect(await w.read(laterId)).toMatchObject({ end_date: '9999-12-31' });
    await w.sweep('2026-10-08T01:00:00Z');
    expect(await w.read(laterId)).toMatchObject({ end_source: 'exit' });
  });
  it('撤销未生效离职申请不登记台账、不改变继任；DEC-440 未生效候选按当前时间轴新日期到期', async () => {
    const e = await w.hire();
    const id = await w.seedRecord(e.id, 'org');
    const app = await w.business(e.id, { kind: 'leave', mode: 'application', lastWorkDate: '2026-10-01' }, e.revision);
    const submitted = await w.requestEmployment('POST', `/businesses/${app.id}/submit`, {
      ifMatch: app.revision,
      body: {},
    });
    expect(submitted.status).toBe(200);
    const reviewing = (await submitted.json()) as EmploymentBusiness;
    const revoked = await w.requestEmployment('POST', `/businesses/${app.id}/revoke`, {
      ifMatch: reviewing.revision,
      body: {},
    });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect(await revoked.json()).toMatchObject({ status: 'voided' });
    await w.sweep('2026-10-09T01:00:00Z');
    expect(await w.apps(e.id)).toEqual([]);
    expect(await w.read(id)).toMatchObject({ revision: 1, end_date: '9999-12-31' });

    const moved = await w.hire();
    const movedId = await w.seedRecord(moved.id, 'org');
    const exit = await w.leave(moved);
    // 只构造 employment 当前时间轴已经改期的输入；本 PR 不新增或实现离职改期入口。
    await w.asTenant(async (tx) => {
      await tx.execute(sql`WITH removed AS (DELETE FROM employment_timeline
        WHERE record_id=${exit.id}::uuid RETURNING *)
        INSERT INTO employment_timeline (tenant_id,employee_id,record_id,staff_id,sort_order,start_date,valid_during)
        SELECT tenant_id,employee_id,record_id,staff_id,sort_order,'2026-10-20'::date,
          daterange('2026-10-20'::date,upper(valid_during),'[)') FROM removed`);
      await tx.execute(sql`UPDATE employment_timeline SET valid_during=daterange(start_date,'2026-10-20'::date,'[)')
        WHERE record_id=${moved.recordId}::uuid`);
    });
    await w.sweep('2026-10-19T01:00:00Z');
    expect(await w.read(movedId)).toMatchObject({ revision: 1, end_date: '9999-12-31' });
    await w.sweep('2026-10-20T01:00:00Z');
    expect(await w.read(movedId)).toMatchObject({ revision: 2, end_date: '2026-10-20', end_source: 'exit' });
    expect((await w.apps(moved.id))[0]!.leave_date).toBe('2026-10-20');
  });
  it('任职写命令直接重放：台账 / 继任修订 / 审计均不重复；订阅失败整单回滚', async () => {
    const e = await w.hire();
    const id = await w.seedRecord(e.id);
    w.setNow(due);
    const options = {
      ifMatch: e.revision,
      body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-10-01' },
      idempotencyKey: randomUUID(),
    };
    const path = `/employees/${e.id}/businesses`;
    const first = await w.requestEmployment('POST', path, options);
    expect(first.status).toBe(201);
    const snapshot = await w.read(id);
    expect((await w.requestEmployment('POST', path, options)).status).toBe(201);
    expect(await w.read(id)).toEqual(snapshot);
    expect(await w.apps(e.id)).toHaveLength(1);
    const failing = await w.hire();
    const failedId = await w.seedRecord(failing.id);
    registerEmployeeStatusHooks('zz-sc-storage-test', {
      async onRecordMaterialized(_tx, _ctx, event) {
        if (event.employeeId === failing.id && event.kind === 'leave') throw new Error('合成存储不可用');
      },
    });
    w.setNow(due);
    const failed = await w.requestEmployment('POST', `/employees/${failing.id}/businesses`, {
      ifMatch: failing.revision,
      body: options.body,
    });
    // errors.ts：未分类的订阅异常精确返回 INTERNAL_ERROR / 500，仍须整个业务回滚。
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(await w.apps(failing.id)).toEqual([]);
    expect(await w.read(failedId)).toMatchObject({ end_date: '9999-12-31', revision: 1 });
  });
  it.each([false, true])('审批即时 / 定时（定时=%s）：只有实际 materialize 才登记并结束', async (future) => {
    const e = await w.hire();
    const id = await w.seedRecord(e.id);
    const app = await w.business(e.id, { kind: 'leave', mode: 'application', lastWorkDate: '2026-10-01' }, e.revision);
    const submitted = await w.requestEmployment('POST', `/businesses/${app.id}/submit`, {
      ifMatch: app.revision,
      body: {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    let current = (await submitted.json()) as EmploymentBusiness;
    const transition = async (action: 'approve' | 'activate', time: string) => {
      const result = await runEmploymentTransition(
        w.db,
        {
          tenantId: w.tenant.id,
          userId: w.user.id,
          timezone: w.tenant.timezone,
          now: new Date(time),
          commandId: randomUUID(),
          expectedRevision: current.revision,
        },
        { id: current.id, action },
      );
      expect(result.status).toBe(200);
      current = result.body as EmploymentBusiness;
    };
    await transition('approve', future ? before : due);
    if (future) {
      expect(current.status).toBe('approved');
      expect(await w.apps(e.id)).toEqual([]);
      expect(await w.read(id)).toMatchObject({ revision: 1, end_date: '9999-12-31' });
      await transition('activate', due);
    }
    expect(current.status).toBe('effective');
    expect(await w.read(id)).toMatchObject({ end_date: '2026-10-02', end_source: 'exit' });
  });
});

describe('AC-SC-02 当前权限与提示', () => {
  it('离职台账 RLS 隔离；跨租户员工 / 任职外键拒绝，范围外 UPDATE 不改变原台账', async () => {
    const a = await exitWorld(testDb().db, 'sc-exit-tenant-a');
    const b = await exitWorld(testDb().db, 'sc-exit-tenant-b');
    const e = await a.hire();
    await a.seedRecord(e.id, 'org');
    const exit = await a.leave(e);
    const snapshot = await a.apps(e.id);
    expect(await b.apps(e.id)).toEqual([]);
    const changed = rowsOf<{ employee_id: string }>(
      await b.asTenant((tx) =>
        tx.execute(sql`
      UPDATE succession_exit_applications SET source='delete_revert'
      WHERE employment_record_id=${exit.id}::uuid RETURNING employee_id`),
      ),
    );
    expect(changed).toEqual([]);
    expect(await a.apps(e.id)).toEqual(snapshot);
    await expect(
      b.asTenant((tx) =>
        tx.execute(sql`
      INSERT INTO succession_exit_applications (tenant_id,employee_id,employment_record_id,
        leave_date,applied_at,source,command_id)
      VALUES (${b.tenant.id}::uuid,${e.id}::uuid,${exit.id}::uuid,
        '2026-10-02',now(),'record_write','sc-cross-tenant')`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
    expect(await a.apps(e.id)).toEqual(snapshot);
  });
  it('系统主体未配置 blocked、恢复同一 run；范围外对象 partial 且无半写；撤权后再页不写', async () => {
    const w = await exitWorld(testDb().db, 'sc-exit-principal');
    const e = await w.hire();
    const id = await w.seedRecord(e.id, 'org');
    const other = await w.org('范围外部门');
    const inside = await w.insertRecord({
      type: 'org',
      targetId: other.id,
      successorId: e.id,
      startDate: '2026-10-01',
    });
    await w.leave(e);
    await w.sweep(due);
    const [run] = rowsOf<{ id: string; status: string; revision: number }>(
      await w.asTenant((tx) =>
        tx.execute(sql`SELECT id,status,revision FROM succession_calc_runs WHERE kind='exit_sweep'`),
      ),
    );
    expect(run!.status).toBe('blocked');
    expect(await w.read(id)).toMatchObject({ revision: 1 });
    const principal = await runner(w, [other.id]);
    await w.asTenant((tx) =>
      changeCalcRun(tx, w.tenant.id, run!.id, run!.revision, 'retry', randomUUID(), new Date(due)),
    );
    expect(await runCalcPage(w.db, w.tenant.id, run!.id, undefined, new Date(due))).toBe('partial');
    expect(await w.read(id)).toMatchObject({ revision: 1 });
    expect(await w.read(inside)).toMatchObject({ revision: 1, end_date: '9999-12-31' });
    const failures = rowsOf<{ code: string }>(
      await w.asTenant((tx) =>
        tx.execute(sql`
      SELECT code FROM succession_calc_run_failures WHERE run_id=${run!.id}::uuid`),
      ),
    );
    expect(failures).toEqual([{ code: 'PRINCIPAL_SCOPE_MISSING' }]);
    await w.asTenant((tx) =>
      tx.execute(sql`UPDATE permission_grants SET status='revoked'
      WHERE user_id=${principal.userId}::uuid`),
    );
    await w.sweep('2026-10-03T01:00:00Z');
    expect(await w.read(id)).toMatchObject({ revision: 1 });
  });
  it('successorLeft 按 asOf 派生，跟随 successorEmployeeId 投影；历史已结束不提示', async () => {
    const w = await exitWorld(testDb().db, 'sc-exit-projection');
    const e = await w.hire();
    await w.leave(e);
    const id = await w.seedRecord(e.id);
    const pw = await permissionWorldOf(w);
    const visible = await recordOperator(pw, { seeAll: true });
    const hidden = await recordOperator(pw, { seeAll: true, hidden: ['successorEmployeeId'] });
    const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date(due) });
    for (const suffix of ['', `/${id}`]) {
      const response = await api.request('GET', `/api/tenant/succession/records${suffix}`, visible.as);
      expect(response.status).toBe(200);
      const data = (await response.json()) as { successorLeft?: boolean; items?: { successorLeft: boolean }[] };
      expect(suffix ? data.successorLeft : data.items![0]!.successorLeft).toBe(true);
      const denied = await api.request('GET', `/api/tenant/succession/records${suffix}`, hidden.as);
      expect(denied.status).toBe(200);
      const h = (await denied.json()) as { items?: Record<string, unknown>[] };
      expect(suffix ? h : h.items![0]).not.toHaveProperty('successorLeft');
    }
    const historical = await api.request('GET', `/api/tenant/succession/records/${id}?asOf=2026-10-01`, visible.as);
    expect(await historical.json()).toMatchObject({ successorLeft: false });
    // 删除事件未产生新离职：记录保持生效；已结束记录不显示“仍生效但离职”的提示。
    await w.asTenant((tx) => tx.execute(sql`UPDATE succession_records SET end_date='2026-10-02' WHERE id=${id}::uuid`));
    const ended = await api.request('GET', `/api/tenant/succession/records/${id}`, visible.as);
    expect(await ended.json()).toMatchObject({ status: 'ended', successorLeft: false });
    const noScope = await recordOperator(pw);
    expect((await api.request('GET', `/api/tenant/succession/records/${id}`, noScope.as)).status).toBe(404);
  });
  it('退休 / 调出和非离职事件不触发；DEC-440 改期订阅保持空实现', async () => {
    const w = await exitWorld(testDb().db, 'sc-exit-nonleave');
    const e = await w.hire();
    const id = await w.seedRecord(e.id);
    const ctx = {
      tenantId: w.tenant.id,
      userId: w.user.id,
      timezone: w.tenant.timezone,
      now: new Date(due),
      commandId: randomUUID(),
    };
    for (const status of [4, 6] as const)
      await withTenant(w.db, w.tenant.id, (tx) =>
        employeeStatusHooks.recordMaterialized(tx, ctx, {
          employeeId: e.id,
          recordId: e.recordId,
          kind: 'leave',
          effectiveDate: '2026-10-02',
          lastWorkDate: '2026-10-01',
          employeeStatus: status,
        }),
      );
    expect(await w.apps(e.id)).toEqual([]);
    expect(await w.read(id)).toMatchObject({ revision: 1 });
    const event = {
      employeeId: e.id,
      recordId: e.recordId,
      kind: 'leave' as const,
      effectiveDate: '2026-10-02',
      lastWorkDate: '2026-10-01',
      employeeStatus: 8 as const,
    };
    await w.asTenant((tx) =>
      successionExitHooks.onRecordRescheduled!(tx, ctx, {
        before: event,
        after: { ...event, effectiveDate: '2026-10-10' },
      }),
    );
    expect(await w.apps(e.id)).toEqual([]);
    expect(await w.read(id)).toMatchObject({ revision: 1 });
  });
});

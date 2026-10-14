import { randomUUID } from 'node:crypto';
import { sql, successionCalcRuns, type DbHandle } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { STANDARD_PROFILES } from '@italent/domain';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { riskWorld } from './AC-SC-risk-support.js';
import { SC_NOW, SC_TODAY } from './AC-SC-support.js';
import { riskPeople } from '../../apps/api/src/modules/succession/risk-people.js';
import { createRiskHandler, riskHandler } from '../../apps/api/src/modules/succession/risk-worker.js';
import { runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { overrideSetting } from '../../apps/api/src/modules/tenant-settings/service.js';
import { riskProducer } from '../../apps/api/src/modules/succession/risk-producer.js';
import { installProfile } from '../../apps/api/src/modules/permission/standard-profiles.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
}, 300000);
afterAll(async () => handle?.close());
it('AC-SC-risk 执行主体在真实 app_user 角色下可通过页授权并补建结果', async () => {
  const w = await riskWorld(handle.db);
  const id = await w.enqueue();
  await w.asTenant(async (tx) => {
    const [run] = await tx.select().from(successionCalcRuns);
    expect(await riskHandler.authorizePage({ tx, run: run!, now: SC_NOW })).toBe(w.user.id);
  });
  expect(await w.run(id)).toBe('succeeded');
  expect(await w.result()).toEqual({ level_id: w.levelId, method: 'computed', revision: 1 });
});
it('AC-SC-risk DEC-450 清除单职位 run 得到新结果；同键重放不再清空或新建 run；缺字段拒绝', async () => {
  const w = await riskWorld(handle.db);
  const path = `/risk-results/${w.position.id}`;
  const missing = await w.request('PUT', path, { ifMatch: 0, body: {} });
  expect(missing.status).toBe(400);
  expect((await missing.json()) as unknown).toMatchObject({ error: { message: expect.any(String) } });
  expect((await w.assign(0)).status).toBe(200);
  const clear = { ifMatch: 1, idempotencyKey: randomUUID(), body: { levelId: null } };
  expect((await w.request('PUT', path, clear)).status).toBe(200);
  const runs = () =>
    w.asTenant(async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(sql`
    SELECT id FROM succession_calc_runs WHERE kind='position_risk'`),
      ),
    );
  const [run] = await runs();
  expect(await runs()).toHaveLength(1);
  expect(
    await w.asTenant(async (tx) =>
      rowsOf(
        await tx.execute(sql`
    SELECT object_id FROM succession_calc_run_objects WHERE run_id=${run!.id}::uuid`),
      ),
    ),
  ).toEqual([{ object_id: w.position.id }]);
  expect(await w.run(run!.id)).toBe('succeeded');
  const computed = await w.result();
  expect(computed).toEqual({ level_id: w.levelId, method: 'computed', revision: 3 });
  expect((await w.request('PUT', path, clear)).status).toBe(200);
  expect(await runs()).toEqual([run]);
  expect(await w.result()).toEqual(computed);
});
it.each(['manual', 'schedule'])('AC-SC-risk DEC-450 %s 批次保护 manual 并补建无结果职位', async (trigger) => {
  const w = await riskWorld(handle.db);
  const blank = await w.newPosition(w.org.id, '无结果关键职位');
  expect((await w.assign(0)).status).toBe(200);
  const before = await w.result();
  if (trigger === 'schedule') await w.asTenant((tx) => riskProducer.runTenant(tx, w.tenant, SC_NOW));
  else
    expect(
      (
        await w.request('POST', '/maps/position/compute-risk', {
          ifMatch: 0,
          body: { showKeyPositions: true, showPositionsWithoutSuccessor: true },
        })
      ).status,
    ).toBe(202);
  const [run] = await w.asTenant((tx) => tx.select().from(successionCalcRuns));
  expect(await w.run(run!.id)).toBe('succeeded');
  expect(await w.result()).toEqual(before);
  expect(
    await w.asTenant(async (tx) =>
      rowsOf(
        await tx.execute(sql`
    SELECT level_id,method,revision FROM succession_risk_results WHERE position_id=${blank.id}::uuid`),
      ),
    ),
  ).toEqual([{ level_id: null, method: 'computed', revision: 1 }]);
});
it('AC-SC-risk DEC-452 work_years 不可用导致对象失败并保留原值，不继续匹配', async () => {
  const w = await riskWorld(handle.db);
  expect(await w.run(await w.enqueue())).toBe('succeeded');
  const before = await w.result();
  await w.asTenant(async (tx) => {
    await installProfile(
      tx,
      {
        tenantId: w.tenant.id,
        actorUserId: null,
        now: SC_NOW,
        commandId: randomUUID(),
      },
      STANDARD_PROFILES.find((p) => p.code === 'standard_hr_admin')!,
    );
    await tx.execute(sql`INSERT INTO permission_grants(tenant_id,user_id,profile_id)
      SELECT ${w.tenant.id}::uuid,${w.user.id}::uuid,id FROM permission_profiles WHERE code='standard_hr_admin'`);
    await tx.execute(sql`INSERT INTO permission_identity_scopes
      (tenant_id,profile_id,app_code,target_kind,target_code,see_all)
      SELECT ${w.tenant.id}::uuid,id,'TenantBase','entity','TenantBase.EmployeeInformation',true
      FROM permission_profiles WHERE code='standard_hr_admin'`);
    // 模拟已更正任职的完整快照；入职日期属于任职周期，不在载荷快照列中。
    await tx.execute(sql`INSERT INTO employment_payload_versions
      SELECT (jsonb_populate_record(NULL::employment_payload_versions, to_jsonb(p) || jsonb_build_object(
        'id',gen_random_uuid(),'version_no',p.version_no+1,'previous_version_id',p.id,
        'is_record_snapshot',true,'command_id',${randomUUID()}::text,'trigger_business_id',p.business_id))).*
      FROM employment_payload_versions p WHERE p.employee_id IN (
        SELECT successor_employee_id FROM succession_records WHERE target_position_id=${w.position.id}::uuid)
      ORDER BY p.version_no DESC LIMIT 1`);
    const people = await riskPeople(
      tx,
      {
        tenantId: w.tenant.id,
        userId: w.user.id,
        positionId: w.position.id,
        asOf: SC_TODAY,
        today: SC_TODAY,
        partTime: false,
      },
      ['entry_date', 'work_years'],
    );
    expect(people.successors[0]?.entry_date).toBe(SC_TODAY);
    expect(people.successors[0]?.work_years).toEqual({ status: 'unavailable' });
    await tx.execute(sql`UPDATE succession_risk_level_rows SET field_code='work_years',filter_operator='ge',
      filter_values='[1]'::jsonb WHERE level_id=${w.levelId}::uuid`);
  });
  const runId = await w.enqueue();
  expect(await w.run(runId)).toBe('partial');
  expect(await w.result()).toEqual(before);
  expect(
    await w.asTenant(async (tx) =>
      rowsOf(
        await tx.execute(sql`
    SELECT code,row_no FROM succession_calc_run_failures WHERE run_id=${runId}::uuid`),
      ),
    ),
  ).toEqual([{ code: 'DATA_UNAVAILABLE', row_no: 1 }]);
});
it('AC-SC-risk 求值宿主遵守兼职设置：关闭不读端口，开启并入兼职并去重', async () => {
  const w = await riskWorld(handle.db);
  const employee = await w.hire('合成兼职人员', { departmentId: w.org.id });
  const reader = vi.fn(async () => [employee.id, employee.id]);
  await w.asTenant((tx) =>
    tx.execute(sql`UPDATE succession_risk_level_rows SET subject='incumbent',
    measure='count_over_incumbents' WHERE level_id=${w.levelId}::uuid`),
  );
  for (const [revision, enabled] of [false, true].entries()) {
    await w.asTenant((tx) =>
      overrideSetting(
        tx,
        {
          tenantId: w.tenant.id,
          userId: w.user.id,
          key: 'succession.part_time_in_risk_calc',
          expectedRevision: revision,
          now: SC_NOW,
          commandId: randomUUID(),
        },
        enabled,
      ),
    );
    const runId = await w.enqueue();
    expect(await runCalcPage(handle.db, w.tenant.id, runId, [createRiskHandler(reader)], SC_NOW)).toBe('succeeded');
    expect((await w.result()).level_id).toBe(enabled ? w.levelId : null);
    expect(reader).toHaveBeenCalledTimes(enabled ? 1 : 0);
  }
});
it.each(['successor', 'incumbent'])('AC-SC-risk 无来源读权：%s 零分母 / 零人口失败并保留原值', async (subject) => {
  const w = await riskWorld(handle.db);
  expect(await w.run(await w.enqueue())).toBe('succeeded');
  const before = await w.result();
  const changed = await w.request('PUT', `/risk-levels/${w.levelId}`, {
    ifMatch: 1,
    body: {
      rules: {
        expression: '1',
        rows: [
          {
            rowNo: 1,
            subject,
            fieldCode: 'age',
            filterOperator: 'eq',
            filterValues: [18],
            measure: 'count_over_incumbents',
            comparator: 'is_empty',
          },
        ],
      },
    },
  });
  expect(changed.status).toBe(200);
  const runId = await w.enqueue();
  expect(await w.run(runId)).toBe('partial');
  expect(await w.result()).toEqual(before);
  expect(
    await w.asTenant(async (tx) =>
      rowsOf(
        await tx.execute(sql`
    SELECT code,row_no FROM succession_calc_run_failures WHERE run_id=${runId}::uuid`),
      ),
    ),
  ).toEqual([{ code: 'FIELD_FORBIDDEN', row_no: 1 }]);
});

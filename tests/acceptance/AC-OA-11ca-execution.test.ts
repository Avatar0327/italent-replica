import { randomUUID } from 'node:crypto';
import { orgAdjustmentTransferItems, orgSettings, sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { findCurrentRecord } from '../../apps/api/src/modules/employment/read-model.js';
import { loadAdjustmentHead, loadExecutionItems } from '../../apps/api/src/modules/org-adjustment/execution-groups.js';
import * as execution from '../../apps/api/src/modules/org-adjustment/executors/index.js';
import { runOrgAdjustmentTenant } from '../../apps/api/src/modules/org-adjustment/execution-runner.js';
import { RUNNER_LEASE_MS } from '../../apps/api/src/modules/org-adjustment/runner-lease.js';
import { transferExecutor } from '../../apps/api/src/modules/org-adjustment/executors/transfer.js';
import { scheduleOrgAdjustmentExecution } from '../../apps/api/src/modules/org-adjustment/schedule.js';
import { normalizeLinkage } from '../../apps/api/src/modules/transfer/linkage/input.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { ALL, BASE, expectError } from './AC-OA-head-support.js';
import { itemsWorld } from './AC-OA-items-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { adjustmentState, seedAdjustment, seedItem, tableRows } from './support/org-adjustment-execution.js';

const testDb = useTestDb();
const date = '2026-11-01';
const formId = 'TenantBase.CrossDepartmentTransferMultiFormView';

async function fixture() {
  const db = testDb().db;
  const w = await itemsWorld(db, 'ZZ_BE11C_EXEC');
  w.setNow('2026-11-03T12:00:00Z');
  const { tenant, hr } = w;
  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, tenant.id, fn);
  const { id } = await seedAdjustment(db, tenant.id, {
    createdBy: hr.id,
    subjectOrgId: w.subject,
    effectiveDate: date,
  });
  const employee = (await w.person('ZZ_BE11C_员工', w.a)).employeeId;
  const ctx = {
    tenantId: tenant.id,
    userId: hr.id,
    timezone: tenant.timezone,
    now: w.clock(),
    commandId: randomUUID(),
  };
  type Draft = Partial<typeof orgAdjustmentTransferItems.$inferInsert>;
  async function row(over: Draft = {}) {
    const itemId = randomUUID();
    await inTenant(async (tx) => {
      const employeeId = over.employeeId ?? employee;
      const record = await findCurrentRecord(tx, tenant.id, employeeId, date);
      const [base] = resultRows<{ revision: number }>(
        await tx.execute(sql`SELECT revision FROM employment_employees WHERE id = ${employeeId}`),
      );
      await tx.insert(orgAdjustmentTransferItems).values({
        id: itemId,
        tenantId: tenant.id,
        adjustmentId: id,
        seq: 1,
        employeeId,
        baseRecordId: record!.id,
        baseEmployeeRevision: base!.revision,
        departmentId: w.b,
        transferTypeCode: 'cross_department',
        formId,
        ...over,
      });
    });
    return itemId;
  }
  const results = () =>
    tableRows<{
      id: string;
      execution_result: number | null;
      execution_reason: string | null;
      exec_phase: number;
      created_business_id: string | null;
    }>(db, tenant.id, 'org_adjustment_transfer_items', id);
  const scopeRows = () =>
    tableRows<{ group_item_id: string; org_id: string }>(db, tenant.id, 'org_adjustment_scope_orgs', id);
  const schedule = (includeTransfers = true) =>
    inTenant((tx) => scheduleOrgAdjustmentExecution(tx, ctx, id, { includeTransfers }));
  const scopeOf = async () => ALL;
  const run = (options: Parameters<typeof runOrgAdjustmentTenant>[3] = {}, connection = db) =>
    runOrgAdjustmentTenant(connection, tenant, w.clock, {
      holderToken: randomUUID(),
      executors: execution.transferExecutors(scopeOf),
      subjectCheck: execution.applicantSubjectCheck(scopeOf),
      ...options,
    });
  return { w, db, tenant, id, employee, ctx, inTenant, row, results, scopeRows, schedule, run };
}

it('内部排期将调动明细计入数据量，按组保存源与目标组织 S', async () => {
  const f = await fixture();
  const itemId = await f.row();
  const scheduled = await f.schedule();
  expect(scheduled.dataVolume, '调动明细必须计入内部排期数据量').toBe(1);
  expect((await f.scopeRows()).map((row) => [row.group_item_id, row.org_id]).sort()).toEqual(
    [f.w.a, f.w.b].map((orgId) => [itemId, orgId]).sort(),
  );
});

it('默认排期与默认执行入口维持关闭，即使表已有内部夹具也不发现调动组', async () => {
  const f = await fixture();
  await f.row();
  expect((await f.schedule(false)).dataVolume).toBe(0);
  expect(await f.scopeRows()).toEqual([]);
  await runOrgAdjustmentTenant(f.db, f.tenant, f.w.clock, { scopeOf: async () => ALL });
  expect(await f.results()).toMatchObject([{ exec_phase: 0, created_business_id: null }]);
});

it('受信组绕过仅限人工的租户开关，写完整调动并在提交回执丢失后按落库终态完成', async () => {
  const f = await fixture();
  await f.row({ linkage: normalizeLinkage({ adjustSalary: true }) });
  expect((await f.schedule()).dataVolume).toBe(1);
  const change = await f.w.call('PUT', '/api/tenant/employment/settings', {
    ifMatch: 0,
    body: { allowDirectTransfer: false },
  });
  expect(change.status, await change.text()).toBe(200);
  const revision = await f.inTenant(
    async (tx) =>
      resultRows<{ revision: number }>(
        await tx.execute(sql`SELECT revision FROM employment_employees WHERE id=${f.employee}`),
      )[0]!.revision,
  );
  await expectError(
    await f.w.call('POST', `/api/tenant/employment/transfers/employees/${f.employee}`, {
      ifMatch: revision,
      body: {
        initiator: 'hr',
        mode: 'direct',
        transferTypeCode: 'cross_department',
        effectiveDate: date,
        fields: { departmentId: f.w.b },
      },
    }),
    409,
    'CONFLICT',
    'DIRECT_TRANSFER_DISABLED',
  );
  let lose = false;
  let lost = 0;
  const flaky = new Proxy(f.db, {
    get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver);
      const original = target.transaction.bind(target);
      return async (...args: Parameters<Db['transaction']>) => {
        const result = await original(...args);
        if (lose) {
          lose = false;
          lost++;
          throw new Error('调动组提交回执丢失');
        }
        return result;
      };
    },
  });
  const statements: string[] = [];
  const executors = execution.transferExecutors(async () => ALL);
  const result = await f.run(
    {
      executors: {
        ...executors,
        transfer: async (tx, input) => {
          const traced = new Proxy(tx, {
            get(target, key, receiver) {
              if (key === 'insert')
                return (table: Parameters<typeof tx.insert>[0]) => {
                  if (table === orgSettings) statements.push('组织设置锁');
                  return target.insert(table);
                };
              if (key !== 'execute') return Reflect.get(target, key, receiver);
              return (query: ReturnType<typeof sql>) => {
                const rendered = query.toQuery({
                  escapeName: (name) => name,
                  escapeParam: (index) => '$' + (index + 1),
                  escapeString: (value) => value,
                });
                statements.push(rendered.sql.replace(/\s+/g, ' '));
                return target.execute(query);
              };
            },
          });
          const outcome = await executors.transfer!(traced, input);
          lose = true;
          return outcome;
        },
      },
    },
    flaky,
  );
  const lockSteps = [
    /employment_employees .*ORDER BY id FOR NO KEY UPDATE/,
    /employment_business_objects .*ORDER BY employee_id,id FOR UPDATE/,
    /SELECT id FROM org_adjustments .*FOR UPDATE/,
    /组织设置锁/,
  ];
  const locks = lockSteps.map((step) => statements.findIndex((query) => step.test(query)));
  expect(locks).toEqual(locks.filter((index) => index >= 0).sort((a, b) => a - b));
  expect(lost).toBe(1);
  expect(result.completed).toEqual([f.id]);
  const [row] = await f.results();
  expect(row).toMatchObject({ execution_result: 1, exec_phase: 2 });
  expect(row!.created_business_id).toBeTruthy();
  const [record] = await f.inTenant(async (tx) =>
    resultRows(
      await tx.execute(sql`SELECT p.kind, p.change_type, p.department_id, r.initiator, r.transfer_type_code
      FROM employment_payload_versions p JOIN transfer_requests r
        ON r.tenant_id=p.tenant_id AND r.business_id=p.business_id
      WHERE p.business_id=${row!.created_business_id}`),
    ),
  );
  expect(record).toMatchObject({
    kind: 'transfer',
    change_type: 'org_adjustment',
    department_id: f.w.b,
    initiator: 'hr',
    transfer_type_code: 'cross_department',
  });
  const [linkage] = await f.inTenant(async (tx) =>
    resultRows(
      await tx.execute(sql`SELECT r.salary_reminder_status FROM transfer_linkage_versions v
      JOIN transfer_linkage_runs r ON r.tenant_id=v.tenant_id AND r.version_id=v.id
      WHERE v.business_id=${row!.created_business_id}`),
    ),
  );
  expect(linkage).toMatchObject({ salary_reminder_status: 'pending' });
  expect(await tableRows(f.db, f.tenant.id, 'org_adjustment_group_attempts', f.id)).toEqual([]);
  expect(await adjustmentState(f.db, f.tenant.id, f.id)).toMatchObject({ success_count: 1, failure_count: 0 });
});

it('运行前复算 S′，发现源部门扩大时终结本组，不触碰扩出的组织', async () => {
  const f = await fixture();
  await f.row();
  expect((await f.schedule()).dataVolume).toBe(1);
  const third = await f.w.org('ZZ_BE11C_另一个源部门', f.tenant.id);
  const revision = await f.inTenant(
    async (tx) =>
      resultRows<{ revision: number }>(
        await tx.execute(sql`SELECT revision FROM employment_employees WHERE id=${f.employee}`),
      )[0]!.revision,
  );
  const response = await f.w.call('POST', `/api/tenant/employment/employees/${f.employee}/businesses`, {
    ifMatch: revision,
    body: { kind: 'transfer', mode: 'direct', effectiveDate: date, fields: { departmentId: third } },
  });
  expect(response.status, await response.text()).toBe(201);
  await f.run({
    hooks: {
      beforeFinalize: async () => {
        expect(await tableRows(f.db, f.tenant.id, 'org_adjustment_pauses', f.id)).toEqual([]);
      },
    },
  });
  expect(await f.results()).toMatchObject([{ execution_result: 2, execution_reason: 'SCOPE_CHANGED' }]);
});

it('同单新增组织先成功才执行人员组；崩溃接管不重复创建两种业务', async () => {
  const f = await fixture();
  const orgItem = await seedItem(f.db, f.tenant.id, f.id, {
    adjust_type: 1,
    parent_org_id: f.w.b,
    name: 'ZZ_BE11C_新组织',
    level: 3,
    seq: 1,
  });
  await f.row({ departmentId: null, departmentItemId: orgItem });
  expect((await f.schedule()).dataVolume).toBe(2);
  const seen: string[] = [];
  await expect(
    f.run({
      hooks: {
        afterGroup: ({ id }) => {
          seen.push(id);
          throw new Error('组提交后退出');
        },
      },
    }),
  ).rejects.toThrow('组提交后退出');
  expect(seen).toEqual([orgItem]);
  f.w.setNow(new Date(f.w.clock().getTime() + RUNNER_LEASE_MS + 1000).toISOString());
  expect((await f.run()).completed).toEqual([f.id]);
  const [org] = await tableRows<{ created_org_id: string }>(f.db, f.tenant.id, 'org_adjustment_org_items', f.id);
  const record = await f.inTenant((tx) => findCurrentRecord(tx, f.tenant.id, f.employee, date));
  expect(record?.fields.departmentId).toBe(org!.created_org_id);
  expect(await adjustmentState(f.db, f.tenant.id, f.id)).toMatchObject({ success_count: 2, failure_count: 0 });
});

it('依赖组失败及人员范围撤销各按业务失败回写，调动业务不落地', async () => {
  const f = await fixture();
  const orgItem = await seedItem(f.db, f.tenant.id, f.id, {
    adjust_type: 1,
    parent_org_id: f.w.b,
    name: 'ZZ_BE11C_失败组织',
    level: 3,
    seq: 1,
  });
  await f.row({ departmentId: null, departmentItemId: orgItem });
  const employeeId = (await f.w.person('ZZ_BE11C_范围外', f.w.a)).employeeId;
  await f.row({ employeeId, seq: 2 });
  expect((await f.schedule()).dataVolume).toBe(3);
  const executors = execution.transferExecutors(async (_tx, query) =>
    query.objectCode === 'TenantBase.EmploymentRecord' ? EMPTY_SCOPE : ALL,
  );
  await f.run({ executors: { ...executors, 1: undefined } });
  expect(
    (await f.results()).sort((a, b) => String(a.execution_reason).localeCompare(String(b.execution_reason))),
  ).toMatchObject([
    { execution_result: 2, execution_reason: 'APPLICANT_OUT_OF_SCOPE', created_business_id: null },
    { execution_result: 2, execution_reason: 'DEPENDENCY_FAILED', created_business_id: null },
  ]);
});

it('公开写入口维持未注册，负责人两项联动继续拒绝', async () => {
  const w = await itemsWorld(testDb().db, 'ZZ_BE11C_CLOSED');
  const view = await w.created();
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const suffix = method === 'POST' ? '' : `/${randomUUID()}`;
    const response = await w.call(method, `${BASE}/${view.id}/transfer-items${suffix}`, { ifMatch: view.revision });
    expect(response.status).toBe(404);
  }
  const worker = await w.person('ZZ_BE11C_负责人', w.a);
  for (const key of ['transferOldHeadSubordinates', 'adjustNewHeadManager']) {
    await expectError(
      await w.addItem(view.id, {
        entry: 'detail.change',
        adjustType: 2,
        targetOrgId: w.a,
        personInChargeId: worker.employeeId,
        transferOldHeadSubordinates: false,
        adjustNewHeadManager: false,
        [key]: true,
      }),
      400,
      'VALIDATION_FAILED',
      'ORG_ADJUSTMENT_HEAD_LINKAGE_NOT_AVAILABLE',
    );
  }
});

it('执行锁内校验员工 revision；基线失效不再追加调动', async () => {
  const f = await fixture();
  await f.row();
  expect((await f.schedule()).dataVolume).toBe(1);
  await f.inTenant((tx) =>
    tx.execute(sql`UPDATE employment_employees SET revision=revision+1
    WHERE tenant_id=${f.tenant.id} AND id=${f.employee}`),
  );
  await f.run();
  expect(await f.results()).toMatchObject([
    { execution_result: 2, execution_reason: 'BASELINE_CHANGED', exec_phase: 2, created_business_id: null },
  ]);
});

async function created(f: Awaited<ReturnType<typeof fixture>>, path: string, body: object) {
  const res = await f.w.call('POST', `/api/tenant/${path}`, { ifMatch: 0, body });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { id: string };
}

it('申请人合同范围撤销，调动组终结并保留原合同', async () => {
  const f = await fixture();
  const type = await created(f, 'contracts/master-data/types', { code: randomUUID(), name: 'ZZ_BE11C_合同类型' });
  const company = await created(f, 'contracts/master-data/companies', {
    code: randomUUID(),
    name: 'ZZ_BE11C_合同公司',
  });
  const contract = await created(f, 'contracts/commands', {
    operation: 'create',
    mode: 'direct',
    employeeId: f.employee,
    fields: {
      typeId: type.id,
      companyId: company.id,
      effectiveDate: '2026-01-01',
      endDate: '2027-12-31',
      termType: 'fixed',
      termMonths: 24,
    },
  });
  await f.row({
    linkage: normalizeLinkage({ contract: { targetId: contract.id, fields: { endDate: '2028-12-31' } } }),
  });
  expect((await f.schedule()).dataVolume).toBe(1);
  await f.run({
    executors: execution.transferExecutors(async (_tx, query) =>
      query.objectCode.includes('Contract') ? EMPTY_SCOPE : ALL,
    ),
  });
  expect(await f.results()).toMatchObject([
    { execution_result: 2, execution_reason: 'APPLICANT_OUT_OF_SCOPE', created_business_id: null },
  ]);
  const [row] = await f.inTenant(async (tx) =>
    resultRows(
      await tx.execute(sql`SELECT count(*)::int AS count
      FROM contract_records WHERE tenant_id=${f.tenant.id} AND employee_id=${f.employee} AND NOT deleted`),
    ),
  );
  expect(row).toEqual({ count: 1 });
});

it.each(['single', 'swap'] as const)('AC-OA-52 内部执行证据 %s：即时校验拒绝并回滚整组', async (mode) => {
  const f = await fixture();
  const parentId = await f.w.org('ZZ_BE11C_编制上级', f.tenant.id);
  const targetId = await f.w.org('ZZ_BE11C_编制目标', parentId);
  const scheme = await created(f, 'establishment/schemes', {
    name: 'ZZ_BE11C_编制方案',
    periodType: 'annual',
    maintenanceMode: 'both',
    startDate: '2026-01-01',
  });
  for (const [orgId, localCapacity, inclusiveCapacity] of [
    [f.w.a, 1, 2],
    [parentId, 2, 12],
    [targetId, 0, 10],
  ] as const) {
    await created(f, 'establishment/capacities', {
      orgId,
      schemeId: scheme.id,
      periodStart: '2026-01-01',
      effectiveDate: '2026-01-01',
      localCapacity,
      inclusiveCapacity,
      strictControl: false,
    });
  }
  await f.row({ departmentId: targetId, withEstablishment: true });
  if (mode === 'swap') {
    const other = await f.w.person('ZZ_BE11C_互调员工', targetId);
    await f.row({ employeeId: other.employeeId, seq: 2, departmentId: f.w.a, withEstablishment: true });
  }
  const snapshot = () =>
    f.inTenant(async (tx) => {
      const query = await tx.execute(sql`SELECT
      (SELECT jsonb_agg(v ORDER BY v.id) FROM establishment_versions v WHERE tenant_id=${f.tenant.id}) AS versions,
      (SELECT count(*)::int FROM transfer_establishment_allocations WHERE tenant_id=${f.tenant.id}) AS allocations,
      (SELECT count(*)::int FROM transfer_requests WHERE tenant_id=${f.tenant.id}) AS transfers`);
      return resultRows(query)[0];
    });
  const before = await snapshot();
  if (mode === 'single') {
    expect((await f.schedule()).dataVolume).toBe(1);
    await f.run();
    expect(await f.results()).toMatchObject([
      { execution_result: 2, execution_reason: 'VALIDATION_FAILED', created_business_id: null },
    ]);
  } else {
    // §7.4：11c 没有多条生成调动行的公开组，这里用同一事务和生产端口验证过渡期拒绝。
    await expect(
      f.inTenant(async (tx) => {
        const adjustment = await loadAdjustmentHead(tx, f.tenant.id, f.id);
        const items = await loadExecutionItems(tx, f.tenant.id, f.id, { includeTransfers: true });
        const [lead] = items;
        return transferExecutor(async () => ALL)(tx, {
          ...f.ctx,
          adjustment,
          group: { id: lead!.id, lead: lead!, items },
        });
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('兄弟部门含下级编制') });
  }
  expect(await snapshot()).toEqual(before);
  expect((await f.results()).every((row) => row.created_business_id === null)).toBe(true);
});

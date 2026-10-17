/**
 * BE-7 PT-2 主职守卫（docs/08_设计/R2-T05_兼职设计.md §3.4 表 B P-05～P-08 / P-11 / P-15 / P-17 / P-22 / P-42 / P-43，
 * §9 PB-07～13、PB-07b / 07c；AC-PT-12“兼职不进主职版本链”）：兼职只经兼职入口读写，通用任职接口对兼职底层业务一律 404
 * 且无写入；主职的向后更新、状态传播、生效队列、组织改名提示、本人记录、合同挂接都看不到兼职。
 * 兼职记录在 PT-3a 之前没有写入口，造数见 AC-PT-support.ts（可信造数直接插记录与期限）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { ownRecords } from '../../apps/api/src/modules/employee-self-service/queries.js';
import {
  listActivationTodos,
  pendingActivations,
  pendingActivationState,
} from '../../apps/api/src/modules/employment/activation-store.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { hasPendingOrgEmployment } from '../../apps/api/src/modules/org/employment-linkage.js';
import { contractWorld } from './AC-CT-support.js';
import { insertPartTimeRecord, partTimeWorld, type PartTimeWorld } from './AC-PT-support.js';

const database = useTestDb();

/** 任职相关表的写入指纹：被拒后逐项相等 = 无写入（含版本号、期限、审计与 outbox）。 */
async function writes(db: Db, tenantId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`SELECT
        (SELECT count(*) FROM employment_payload_versions WHERE tenant_id=${tenantId}) AS versions,
        (SELECT count(*) FROM employment_state_events WHERE tenant_id=${tenantId}) AS events,
        (SELECT count(*) FROM employment_records WHERE tenant_id=${tenantId}) AS records,
        (SELECT count(*) FROM employment_timeline WHERE tenant_id=${tenantId}) AS timeline,
        (SELECT count(*) FROM employment_part_time_terms WHERE tenant_id=${tenantId}) AS terms,
        (SELECT count(*) FROM audit_events WHERE tenant_id=${tenantId}) AS audits,
        (SELECT count(*) FROM employment_outbox WHERE tenant_id=${tenantId}) AS outbox,
        (SELECT string_agg(id::text || ':' || revision, ',' ORDER BY id) FROM employment_business_objects
          WHERE tenant_id=${tenantId}) AS heads,
        (SELECT string_agg(id::text || ':' || revision, ',' ORDER BY id) FROM employment_employees
          WHERE tenant_id=${tenantId}) AS employees`),
    );
    return row;
  });
}

async function hireOf(w: PartTimeWorld) {
  const hire = (await w.records(w.employeeId)).find((record) => record.kind === 'hire');
  const response = await w.request('GET', `/businesses/${hire!.id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; revision: number; employeeRevision: number };
}

describe('AC-PT-12 PB-07：通用任职接口对兼职底层业务一律 404，无写入（P-05 / P-06）', () => {
  it('读取、修改、提交 / 撤回 / 撤销、删除、生效重试、记录编辑与编辑预览', async () => {
    const w = await partTimeWorld(database().db, 'pb07');
    const id = await w.seedPartTime({ endDate: '2026-12-31', place: '兼职地点' });
    const before = await writes(w.db, w.tenantId);
    const patch = { body: { fields: { place: '改写' } } };
    const calls: [string, string, Record<string, unknown>][] = [
      ['GET', `/businesses/${id}`, {}],
      ['GET', `/records/${id}`, {}],
      ['PATCH', `/businesses/${id}`, { ifMatch: 1, ...patch }],
      ['POST', `/businesses/${id}/submit`, { ifMatch: 1 }],
      ['POST', `/businesses/${id}/withdraw`, { ifMatch: 1 }],
      ['POST', `/businesses/${id}/revoke`, { ifMatch: 1 }],
      ['DELETE', `/businesses/${id}`, { ifMatch: 1 }],
      ['POST', `/businesses/${id}/activation/retry`, { ifMatch: 1 }],
      ['PATCH', `/records/${id}`, { ifMatch: 1, ...patch }],
      ['POST', `/records/${id}/forward-update-preview`, patch],
    ];
    for (const [method, path, options] of calls) {
      const response = await w.request(method, path, options);
      expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBe(404);
      expect((await response.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    expect(await writes(w.db, w.tenantId)).toEqual(before);
    // 主职记录照常可读可写（守卫只拦兼职）
    const hire = await hireOf(w);
    const edited = await w.request('PATCH', `/records/${hire.id}`, { ifMatch: hire.revision, ...patch });
    expect(edited.status, await edited.clone().text()).toBe(200);
  });

  it('PB-07b：兼职底层业务放进批量编辑 → 404，整批回滚（主职那条也不改，P-42）', async () => {
    const w = await partTimeWorld(database().db, 'pb07b');
    const id = await w.seedPartTime();
    const hire = await hireOf(w);
    const before = await writes(w.db, w.tenantId);
    const response = await w.request('POST', '/records/batch-edit', {
      body: {
        items: [
          { id: hire.id, revision: hire.revision },
          { id, revision: 1 },
        ],
        patch: { fields: { place: '批量改写' } },
      },
    });
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await writes(w.db, w.tenantId)).toEqual(before);
  });

  it('PB-07c：兼职底层业务作为导入的编辑行 → 404，整批回滚（P-43）', async () => {
    const w = await partTimeWorld(database().db, 'pb07c');
    const id = await w.seedPartTime();
    const hire = await hireOf(w);
    const before = await writes(w.db, w.tenantId);
    const response = await w.request('POST', `/employees/${w.employeeId}/import`, {
      ifMatch: hire.employeeRevision,
      body: {
        items: [
          { operation: 'edit', id: hire.id, revision: hire.revision, patch: { fields: { place: '导入改写' } } },
          { operation: 'edit', id, revision: 1, patch: { fields: { place: '导入改写' } } },
        ],
      },
    });
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await writes(w.db, w.tenantId)).toEqual(before);
  });
});

describe('AC-FWD-11（守卫）/ PB-08 / PB-09：兼职不是向后更新与状态传播的目标（P-07 / P-08）', () => {
  it('PB-08：编辑当前主职记录的地点 → 后续主职记录随之更新，兼职记录不动、不追加版本', async () => {
    const w = await partTimeWorld(database().db, 'pb08');
    const hire = await hireOf(w);
    const place = (id: string, revision: number, value: string) =>
      w.request('PATCH', `/records/${id}`, { ifMatch: revision, body: { fields: { place: value } } });
    expect((await place(hire.id, hire.revision, '原地点')).status).toBe(200);
    const later = await w.business(
      w.employeeId,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-01' },
      (await w.getEmployee(w.employeeId)).revision,
    );
    const partTime = await w.seedPartTime({ startDate: '2026-09-01', place: '原地点' });
    const current = await hireOf(w);
    const preview = await w.request('POST', `/records/${current.id}/forward-update-preview`, {
      body: { fields: { place: '新地点' } },
    });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const plan = JSON.stringify(await preview.json());
    expect(plan).toContain(later.id);
    expect(plan).not.toContain(partTime);
    expect((await place(current.id, current.revision, '新地点')).status).toBe(200);
    expect((await w.record(later.id)).fields.place).toBe('新地点');
    expect(await versions(w, partTime)).toEqual(['1:原地点:3']);
  });

  it('PB-09：转正向后传播“正式”，兼职记录的人员状态快照不变、不追加版本', async () => {
    const w = await partTimeWorld(database().db, 'pb09');
    const employee = await w.employee('试用员工');
    await withTenant(w.db, w.tenantId, (tx) =>
      createEmploymentBusiness(
        tx,
        w.context(employee.revision),
        employee.id,
        { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: w.primaryOrg.id } },
        { entry: { probation: true } },
      ),
    );
    const later = await w.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-12-01' },
      (await w.getEmployee(employee.id)).revision,
    );
    const partTime = await withTenant(w.db, w.tenantId, (tx) =>
      insertPartTimeRecord(tx, {
        tenantId: w.tenantId,
        employeeId: employee.id,
        departmentId: w.partTimeOrg.id,
        startDate: '2026-10-15',
        endDate: null,
      }),
    );
    expect(await versions(w, partTime)).toEqual(['1:2']);
    await w.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-10-01', fields: {} },
      (await w.getEmployee(employee.id)).revision,
    );
    expect((await w.record(later.id)) as unknown as { employeeStatus: number }).toMatchObject({ employeeStatus: 3 });
    expect(await versions(w, partTime)).toEqual(['1:2']);
  });
});

/** 兼职底层业务的载荷版本（“版本号:地点:人员状态”）：不追加版本 = 只有第 1 版且值不变。 */
const versions = (w: PartTimeWorld, id: string) =>
  withTenant(w.db, w.tenantId, async (tx) =>
    rowsOf<{ v: string }>(
      await tx.execute(sql`SELECT concat_ws(':', version_no, place, employee_status) AS v
        FROM employment_payload_versions WHERE tenant_id=${w.tenantId} AND business_id=${id} ORDER BY version_no`),
    ).map((row) => row.v),
  );

describe('PB-10：兼职（含未来开始）不进生效队列、HR 生效待办与调度到期集合（P-22 回归）', () => {
  it('pendingActivations / listActivationTodos / pendingActivationState 都看不到兼职底层业务', async () => {
    const w = await partTimeWorld(database().db, 'pb10');
    const current = await w.seedPartTime({ startDate: '2026-09-01' });
    const future = await w.seedPartTime({ startDate: '2026-12-01', endDate: '2027-03-31' });
    const ctx = w.context();
    await withTenant(w.db, w.tenantId, async (tx) => {
      const queue = JSON.stringify(await pendingActivations(tx, ctx, w.employeeId));
      const todos = JSON.stringify(
        await listActivationTodos(tx, w.tenantId, { limit: 200, offset: 0 }, undefined, ctx.timezone),
      );
      for (const id of [current, future]) expect(`${queue}${todos}`).not.toContain(id);
      const [due] = rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM employment_business_objects b
          JOIN LATERAL (SELECT * FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id
            AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
          JOIN LATERAL (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id
            AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
          WHERE b.tenant_id=${w.tenantId} AND b.id IN (${current}, ${future})
            AND ${pendingActivationState(ctx.timezone)}`),
      );
      expect(due!.n).toBe(0);
    });
  });
});

describe('PB-11 / PB-13 / PB-12：组织改名提示、本人记录、合同挂接（P-11 / P-15 / P-17）', () => {
  it('PB-11：兼职部门里只有未来开始的兼职 → 组织改名 / 改上级不提示“存在未生效任职”', async () => {
    const w = await partTimeWorld(database().db, 'pb11');
    await w.seedPartTime({ startDate: '2026-12-01' });
    const ctx: EmploymentContext = w.context();
    const pending = await withTenant(w.db, w.tenantId, (tx) =>
      hasPendingOrgEmployment(tx, ctx, w.partTimeOrg.id, '2027-01-01'),
    );
    expect(pending).toBe(false);
  });

  it('PB-13：员工自助“我的记录”不出现兼职底层业务，分页按主职记录计（P-15）', async () => {
    const w = await partTimeWorld(database().db, 'pb13');
    const partTime = await w.seedPartTime({ startDate: '2026-09-01' });
    const ctx = w.context();
    const hire = (await w.records(w.employeeId)).find((record) => record.kind === 'hire');
    await withTenant(w.db, w.tenantId, async (tx) => {
      const all = await ownRecords(tx, ctx, w.employeeId, { limit: 50, offset: 0 });
      expect(all.map((item) => item.id)).toEqual([hire!.id]);
      // 兼职开始日晚于入职日，按生效日倒序会排在第一页第一条：SQL 层就要排除，不能只在读出后丢弃
      const first = await ownRecords(tx, ctx, w.employeeId, { limit: 1, offset: 0 });
      expect(first.map((item) => item.id)).toEqual([hire!.id]);
      expect(JSON.stringify(all)).not.toContain(partTime);
    });
  });

  it('PB-12：合同挂兼职记录 → 400 VALIDATION_FAILED；挂主职记录照常成功', async () => {
    const w = await contractWorld(database().db, 'pb12');
    const partTime = await withTenant(w.db, w.session.tenant.id, (tx) =>
      insertPartTimeRecord(tx, {
        tenantId: w.session.tenant.id,
        employeeId: w.employee.id,
        departmentId: w.org.id,
        startDate: '2025-06-01',
        endDate: null,
      }),
    );
    const command = (employmentRecordId: string) =>
      w.request('POST', '/commands', {
        ifMatch: 0,
        idempotencyKey: randomUUID(),
        body: {
          operation: 'create',
          mode: 'direct',
          employeeId: w.employee.id,
          fields: { ...w.fields, employmentRecordId },
        },
      });
    const rejected = await command(partTime);
    expect(rejected.status, await rejected.clone().text()).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    const hire = (await w.session.records(w.employee.id)).find((record) => record.kind === 'hire');
    const accepted = await command(hire!.id);
    expect(accepted.status, await accepted.clone().text()).toBe(201);
  });
});

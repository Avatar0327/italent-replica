/**
 * F-022：人员状态 / 入职状态不可手工编辑（15 §9.3）；所有追加任职版本的路径都继承上一版本的两个状态字段。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { insertEmploymentRow } from '../../apps/api/src/modules/employment/record-store.js';
import { transitionEmployment } from '../../apps/api/src/modules/employment/transitions.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { employmentSession, type EmploymentSession } from './AC-EMP-support.js';

const testDb = useTestDb();
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

function context(session: EmploymentSession, expectedRevision: number, at = '2026-10-01T01:00:00Z') {
  return {
    tenantId: session.tenant.id,
    userId: session.user.id,
    timezone: session.tenant.timezone,
    now: new Date(at),
    commandId: randomUUID(),
    expectedRevision,
  } satisfies EmploymentContext;
}

/** 试用期员工：入职端口带“有试用期”（R2-T01 接线前由可信调用方传入）。 */
async function probationer(session: EmploymentSession) {
  const org = await session.org(`继承部门${randomUUID().slice(0, 6)}`, { establishedOn: '2026-01-01' });
  const employee = await session.employee();
  const hire = await withTenant(testDb().db, session.tenant.id, (tx) =>
    createEmploymentBusiness(
      tx,
      context(session, employee.revision),
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { employType: 'internal', departmentId: org.id },
      },
      { entry: { probation: true } },
    ),
  );
  return { org, employee, hire };
}

async function currentStatuses(session: EmploymentSession, employeeId: string, asOf = '2026-10-01') {
  const items = (await session.records(employeeId, asOf)) as unknown as {
    id: string;
    kind: string;
    revision: number;
    employeeStatus: number;
    entryStatus: number | null;
  }[];
  return items;
}

async function versionStatuses(session: EmploymentSession, businessId: string) {
  return withTenant(testDb().db, session.tenant.id, async (tx) =>
    rows<{ s: number; snapshot: boolean }>(
      await tx.execute(sql`SELECT employee_status AS s, is_record_snapshot AS snapshot FROM employment_payload_versions
        WHERE tenant_id=${session.tenant.id} AND business_id=${businessId}::uuid ORDER BY version_no`),
    ),
  );
}

describe('AC-EMP-18 人员状态 / 入职状态不可手工编辑', () => {
  it('新增业务、任职编辑、批量编辑、导入（新增与编辑）都拒绝这两个字段，原数据不变', async () => {
    const session = await employmentSession(testDb().db, 'empreadonly');
    const { employee, hire } = await probationer(session);
    const record = hire.record!;
    const revision = (await session.getEmployee(employee.id)).revision;
    const attempts: [string, string, Record<string, unknown>, number?][] = [
      [
        'POST',
        `/employees/${employee.id}/businesses`,
        { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: { employeeStatus: 3 } },
        revision,
      ],
      [
        'POST',
        `/employees/${employee.id}/businesses`,
        { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: {}, entryStatus: 2 },
        revision,
      ],
      ['PATCH', `/records/${record.id}`, { fields: { employeeStatus: 3 } }, hire.revision],
      ['PATCH', `/records/${record.id}`, { fields: { entryStatus: null } }, hire.revision],
      [
        'POST',
        '/records/batch-edit',
        { items: [{ id: record.id, revision: hire.revision }], patch: { fields: { employeeStatus: 3 } } },
      ],
      [
        'POST',
        `/employees/${employee.id}/import`,
        {
          items: [
            {
              operation: 'create',
              business: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: { entryStatus: 0 } },
            },
          ],
        },
        revision,
      ],
      [
        'POST',
        `/employees/${employee.id}/import`,
        {
          items: [
            { operation: 'edit', id: record.id, revision: hire.revision, patch: { fields: { employeeStatus: 3 } } },
          ],
        },
        revision,
      ],
    ];
    for (const [method, path, body, ifMatch] of attempts) {
      const response = await session.request(method, path, { body, ...(ifMatch === undefined ? {} : { ifMatch }) });
      expect(response.status, `${method} ${path}`).toBe(400);
      expect(await response.json(), `${method} ${path}`).toMatchObject({
        error: { code: 'VALIDATION_FAILED', details: { reason: 'EMPLOYEE_STATUS_READONLY' } },
      });
    }
    expect(await currentStatuses(session, employee.id)).toEqual([
      expect.objectContaining({ id: record.id, employeeStatus: 2, entryStatus: null }),
    ]);
  });
});

describe('AC-EMP-19 追加任职版本的各路径继承上一版本的人员状态 / 入职状态', () => {
  it('调动、任职编辑、批量编辑、导入、申请改单与生效、向后更新快照都保持试用', async () => {
    const session = await employmentSession(testDb().db, 'empinherit01');
    const { employee, hire } = await probationer(session);
    const target = await session.org('继承调入部门', { establishedOn: '2026-01-01' });
    const third = await session.org('继承申请部门', { establishedOn: '2026-01-01' });
    // 未来调动（之后被当前编辑向后更新，追加快照）
    let revision = (await session.getEmployee(employee.id)).revision;
    const future = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-12-01', fields: { departmentId: target.id } },
      revision,
    );
    // 任职编辑当前记录：本条追加快照，未来调动经向后更新追加快照
    const edit = await session.request('PATCH', `/records/${hire.record!.id}`, {
      ifMatch: hire.revision,
      body: { fields: { place: '继承地点' } },
    });
    expect(edit.status, await edit.clone().text()).toBe(200);
    const edited = (await edit.json()) as { revision: number };
    // 批量编辑
    const batch = await session.request('POST', '/records/batch-edit', {
      body: { items: [{ id: hire.record!.id, revision: edited.revision }], patch: { fields: { remarks: '批量' } } },
    });
    expect(batch.status, await batch.clone().text()).toBe(200);
    // 导入新增
    revision = (await session.getEmployee(employee.id)).revision;
    const imported = await session.request('POST', `/employees/${employee.id}/import`, {
      ifMatch: revision,
      body: {
        items: [
          {
            operation: 'create',
            business: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-15', fields: { place: '导入地点' } },
          },
        ],
      },
    });
    expect(imported.status, await imported.clone().text()).toBe(200);
    // 申请：创建、改单、提交、审批通过并生效
    revision = (await session.getEmployee(employee.id)).revision;
    const application = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-20', fields: { departmentId: third.id } },
      revision,
    );
    const patched = await session.request('PATCH', `/businesses/${application.id}`, {
      ifMatch: application.revision,
      body: { fields: { remarks: '改单' } },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    let businessRevision = ((await patched.json()) as { revision: number }).revision;
    for (const [action, at] of [
      ['submit', '2026-10-01T01:00:00Z'],
      ['approve', '2026-10-01T01:00:00Z'],
      ['activate', '2026-10-20T01:00:00Z'],
    ] as const) {
      const saved = await withTenant(testDb().db, session.tenant.id, (tx) =>
        transitionEmployment(tx, context(session, businessRevision, at), { id: application.id, action }),
      );
      businessRevision = saved.revision;
    }
    const statuses = await currentStatuses(session, employee.id, '2026-12-31');
    expect(statuses.map((record) => record.employeeStatus)).toEqual(statuses.map(() => 2));
    expect(statuses.map((record) => record.kind)).toEqual(['hire', 'transfer', 'transfer', 'transfer']);
    for (const id of [hire.record!.id, future.record!.id, application.id]) {
      const versions = await versionStatuses(session, id);
      expect(versions.length, id).toBeGreaterThan(1);
      expect(
        versions.every((version) => version.s === 2),
        id,
      ).toBe(true);
    }
  });

  it('申请在转正之前创建、在转正之后落地：按落地时的前一条继承为正式', async () => {
    const session = await employmentSession(testDb().db, 'empinherit02');
    const { employee } = await probationer(session);
    const org = await session.org('落地调入部门', { establishedOn: '2026-01-01' });
    let revision = (await session.getEmployee(employee.id)).revision;
    const application = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-12-01', fields: { departmentId: org.id } },
      revision,
    );
    expect((await versionStatuses(session, application.id)).map((version) => version.s)).toEqual([2]);
    revision = (await session.getEmployee(employee.id)).revision;
    await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-11-01', fields: {} },
      revision,
    );
    // 转正的向后更新同样追加了在途申请的载荷版本
    expect((await versionStatuses(session, application.id)).map((version) => version.s)).toEqual([2, 3]);
    let businessRevision = (await session.request('GET', `/businesses/${application.id}`).then((r) => r.json()))
      .revision as number;
    for (const [action, at] of [
      ['submit', '2026-10-01T01:00:00Z'],
      ['approve', '2026-10-01T01:00:00Z'],
      ['activate', '2026-12-01T01:00:00Z'],
    ] as const) {
      const saved = await withTenant(testDb().db, session.tenant.id, (tx) =>
        transitionEmployment(tx, context(session, businessRevision, at), { id: application.id, action }),
      );
      businessRevision = saved.revision;
    }
    const statuses = await currentStatuses(session, employee.id, '2026-12-01');
    expect(statuses.map((record) => [record.kind, record.employeeStatus])).toEqual([
      ['hire', 2],
      ['regularization', 3],
      ['transfer', 3],
    ]);
  });

  it('公共追加入口：调用方展开旧载荷带来的状态值被忽略，快照继承当前记录、普通版本继承上一版本', async () => {
    const session = await employmentSession(testDb().db, 'empinherit03');
    const { employee, hire } = await probationer(session);
    const recordId = hire.record!.id;
    await withTenant(testDb().db, session.tenant.id, async (tx) => {
      const [payload] = rows<Record<string, unknown>>(
        await tx.execute(sql`SELECT id FROM employment_payload_versions
          WHERE tenant_id=${session.tenant.id} AND business_id=${recordId}::uuid ORDER BY version_no DESC LIMIT 1`),
      );
      // 模拟 F-021 / F-007 等路径：展开旧载荷（含过期的状态值）追加快照
      await insertEmploymentRow(tx, 'employment_payload_versions', {
        id: randomUUID(),
        tenantId: session.tenant.id,
        employeeId: employee.id,
        businessId: recordId,
        versionNo: 2,
        previousVersionId: payload!.id,
        commandId: 'stale-spread',
        triggerBusinessId: recordId,
        isRecordSnapshot: true,
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        formId: 'standard',
        employType: 'internal',
        employeeStatus: 12,
        entryStatus: 1,
      });
    });
    expect(await versionStatuses(session, recordId)).toEqual([
      { s: 2, snapshot: false },
      { s: 2, snapshot: true },
    ]);
    // 绕过应用层的原始 SQL 追加（不带状态列）同样由数据库按版本链继承
    await withTenant(testDb().db, session.tenant.id, (tx) =>
      tx.execute(sql`
        INSERT INTO employment_payload_versions
          (id,tenant_id,employee_id,business_id,version_no,previous_version_id,command_id,trigger_business_id,
           is_record_snapshot,kind,mode,effective_date,form_id,employ_type)
        SELECT gen_random_uuid(),tenant_id,employee_id,business_id,3,id,'raw-sql',business_id,true,kind,mode,
          effective_date,form_id,employ_type
        FROM employment_payload_versions
        WHERE tenant_id=${session.tenant.id} AND business_id=${recordId}::uuid AND version_no=2`),
    );
    expect((await versionStatuses(session, recordId)).map((version) => version.s)).toEqual([2, 2, 2]);
  });
});

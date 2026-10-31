/**
 * F-323（DEC-706）第 1 轮审查 P2-1：停用只拦“新选 / 改选”，沿用原记录类别的继承路径保留已停用的原引用。
 * 离职、结束兼职、调动、编辑其他字段都不改人员类别；显式新选 / 改选已停用类别仍 422。只用合成人员。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { gateWorld, leaveBody, type GateWorld } from './AC-EXIT-gate-support.js';
import { employmentTypeId } from './AC-EMP-support.js';

const database = useTestDb();

async function typeWorld(label: string) {
  const w = await gateWorld(database().db, `f323-inherit-${label}`);
  const tenantId = w.session.tenant.id;
  const id = (name: string) => employmentTypeId(database().db, tenantId, name);
  const disable = async (type: string) => {
    const response = await w.session.request('POST', `/employment-types/${type}/disable`, { ifMatch: 1 });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  /** 已入职并引用类别 type 的员工（编辑入职记录写入引用）。 */
  const typedEmployee = async (type: string) => {
    const { employee, hire } = await w.hired();
    const patched = await w.session.request('PATCH', `/records/${hire.id}`, {
      ifMatch: hire.revision,
      body: { fields: { employmentType: type } },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    return { employee, hire: (await patched.json()) as { id: string; revision: number } };
  };
  const createPartTime = async (employeeId: string, fields: Record<string, unknown>) => {
    const owner = await w.session.getEmployee(employeeId);
    return w.session.request('POST', `/employees/${employeeId}/part-times`, {
      ifMatch: owner.revision,
      body: { partTimeType: 'part_time', startDate: '2026-09-10', fields: { departmentId: w.to.id, ...fields } },
    });
  };
  return { ...w, id, disable, typedEmployee, createPartTime };
}

const payloadTypes = (w: GateWorld, businessId: string) =>
  w.sqlRows<{ type: string | null }>(sql`SELECT employment_type::text AS type FROM employment_payload_versions
    WHERE tenant_id=${w.session.tenant.id} AND business_id=${businessId}::uuid ORDER BY version_no`);

it('AC-EMP-F323-12：员工已引用的类别被停用后发起离职 → 201，离职记录沿用原引用', async () => {
  const w = await typeWorld('exit');
  const type = await w.id('技术开发');
  const { employee } = await w.typedEmployee(type);
  await w.disable(type);
  const response = await w.createLeave(employee.id, leaveBody('2026-10-20', 'direct'));
  expect(response.status, await response.clone().text()).toBe(201);
  const leave = (await response.json()) as { id: string };
  expect((await payloadTypes(w, leave.id)).map((row) => row.type)).toEqual([type]);
});

it('AC-EMP-F323-13：兼职已引用的类别被停用后结束兼职 → 201，申请版本沿用原引用', async () => {
  const w = await typeWorld('end-part-time');
  const type = await w.id('技术开发');
  const { employee } = await w.hired();
  const created = await w.createPartTime(employee.id, { employmentType: type });
  expect(created.status, await created.clone().text()).toBe(201);
  const record = (await created.json()) as { id: string };
  await w.disable(type);
  const response = await w.session.request('POST', '/part-time-requests', {
    ifMatch: 0,
    body: { requestType: 'end', recordId: record.id, endDate: '2026-09-20' },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const request = (await response.json()) as { id: string };
  const versions = await w.sqlRows<{ type: string | null }>(sql`SELECT employment_type::text AS type
    FROM part_time_request_versions WHERE tenant_id=${w.session.tenant.id} AND request_id=${request.id}::uuid`);
  expect(versions.map((row) => row.type)).toEqual([type]);
});

it('AC-EMP-F323-14：同类继承路径（调动、编辑其他字段、兼职改部门）沿用已停用的原引用不受阻', async () => {
  const w = await typeWorld('same-class');
  const type = await w.id('技术开发');
  const transferred = await w.typedEmployee(type);
  const edited = await w.typedEmployee(type);
  const { employee } = await w.hired('兼职员工');
  const created = await w.createPartTime(employee.id, { employmentType: type });
  expect(created.status, await created.clone().text()).toBe(201);
  const partTime = (await created.json()) as { id: string; revision: number };
  await w.disable(type);
  const owner = await w.session.getEmployee(transferred.employee.id);
  const transfer = await w.session.request('POST', `/employees/${transferred.employee.id}/businesses`, {
    ifMatch: owner.revision,
    body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-10', fields: { departmentId: w.to.id } },
  });
  expect(transfer.status, await transfer.clone().text()).toBe(201);
  expect((await payloadTypes(w, ((await transfer.json()) as { id: string }).id)).map((row) => row.type)).toEqual([
    type,
  ]);
  const place = await w.session.request('PATCH', `/records/${edited.hire.id}`, {
    ifMatch: edited.hire.revision,
    body: { fields: { place: '新地点' } },
  });
  expect(place.status, await place.clone().text()).toBe(200);
  const other = await w.session.org('兼职改调部门', { establishedOn: '2026-01-01' });
  const moved = await w.session.request('PATCH', `/part-times/${partTime.id}`, {
    ifMatch: partTime.revision,
    body: { fields: { departmentId: other.id } },
  });
  expect(moved.status, await moved.clone().text()).toBe(200);
});

it('AC-EMP-F323-15：显式新选 / 改选已停用类别仍 422（入职、编辑任职、兼职新增与编辑），不回退原约束', async () => {
  const w = await typeWorld('explicit');
  const kept = await w.id('运维服务');
  const stopped = await w.id('技术开发');
  const { employee, hire } = await w.typedEmployee(kept);
  const created = await w.createPartTime(employee.id, { employmentType: kept });
  expect(created.status, await created.clone().text()).toBe(201);
  const partTime = (await created.json()) as { id: string; revision: number };
  await w.disable(stopped);
  const refusal = { error: { code: 'EMPLOYMENT_TYPE_INVALID', details: { reason: 'EMPLOYMENT_TYPE_DISABLED' } } };
  const fresh = await w.session.employee('新入职员工');
  const hireDisabled = await w.session.request('POST', `/employees/${fresh.id}/businesses`, {
    ifMatch: fresh.revision,
    body: {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId: w.from.id, employmentType: stopped },
    },
  });
  expect(hireDisabled.status, await hireDisabled.clone().text()).toBe(422);
  expect(await hireDisabled.json()).toMatchObject(refusal);
  const editDisabled = await w.session.request('PATCH', `/records/${hire.id}`, {
    ifMatch: hire.revision,
    body: { fields: { employmentType: stopped } },
  });
  expect(editDisabled.status, await editDisabled.clone().text()).toBe(422);
  expect(await editDisabled.json()).toMatchObject(refusal);
  const owner = await w.session.getEmployee(employee.id);
  const transferDisabled = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
    ifMatch: owner.revision,
    body: {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-10',
      fields: { departmentId: w.to.id, employmentType: stopped },
    },
  });
  expect(transferDisabled.status, await transferDisabled.clone().text()).toBe(422);
  const partTimeDisabled = await w.createPartTime(employee.id, { employmentType: stopped });
  expect(partTimeDisabled.status, await partTimeDisabled.clone().text()).toBe(422);
  expect(await partTimeDisabled.json()).toMatchObject(refusal);
  const partTimeEdit = await w.session.request('PATCH', `/part-times/${partTime.id}`, {
    ifMatch: partTime.revision,
    body: { fields: { employmentType: stopped } },
  });
  expect(partTimeEdit.status, await partTimeEdit.clone().text()).toBe(422);
  expect(await partTimeEdit.json()).toMatchObject(refusal);
});

/**
 * DEC-244②：来源删除不级联、不重算，后续记录保留的值视为意图；之后的无关操作（PATCH 其他字段、简单迟到执行、再次
 * F-007 联动）都不得撤回。DEC-244③：已传播的历史值按传播发生时的继承配置固定，之后关闭（或开启）继承不影响已有记录。
 * 迟到重建本身已移交 F-036（DEC-278）：这里的迟到调动是 10-09 当天最后一次操作，[10-09, 10-10) 内它之后没有其他记录，
 * 10-10 执行时属于简单迟到，照常顺延。
 */
import { runEmploymentActivations } from '@italent/api';
import type { Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { orgPeopleWorld, type OrgPeopleWorld } from './AC-ORG-people-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const SOURCE_PLACE = '来源地点 B';

async function simpleLateTransfer(w: OrgPeopleWorld, employeeId: string) {
  return w.business(
    employeeId,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-09', fields: { remarks: '仅改备注的迟到调动' } },
    (await w.getEmployee(employeeId)).revision,
  );
}

async function rename(w: OrgPeopleWorld, orgId: string, employeeId: string, effectiveDate: string, name: string) {
  const current = (await w.orgsAt(effectiveDate)).get(orgId)!;
  const before = new Set((await w.records(employeeId, effectiveDate)).map((r) => r.id));
  const response = await w.patchOrg(current, { name, effectiveDate, addEmployment: true });
  expect(response.status, await response.clone().text()).toBe(200);
  const added = (await w.records(employeeId, effectiveDate)).filter((r) => !before.has(r.id));
  expect(added).toHaveLength(1);
  return added[0]!.id;
}

async function source(w: OrgPeopleWorld, employeeId: string, kind: 'transfer' | 'org_adjustment', body: object) {
  return w.business(
    employeeId,
    { kind, mode: 'direct', effectiveDate: '2026-10-07', ...body },
    (await w.getEmployee(employeeId)).revision,
  );
}

async function deleteBusiness(w: OrgPeopleWorld, id: string) {
  const current = await w.request('GET', `/businesses/${id}`);
  expect(current.status).toBe(200);
  const { revision } = (await current.json()) as { revision: number };
  const deleted = await w.request('DELETE', `/businesses/${id}`, { ifMatch: revision });
  expect(deleted.status, await deleted.clone().text()).toBe(200);
}

async function patchRemarks(w: OrgPeopleWorld, id: string, remarks: string) {
  const current = await w.request('GET', `/businesses/${id}`);
  expect(current.status).toBe(200);
  const { revision } = (await current.json()) as { revision: number };
  const patched = await w.request('PATCH', `/records/${id}`, { ifMatch: revision, body: { fields: { remarks } } });
  expect(patched.status, await patched.clone().text()).toBe(200);
}

async function runLate(db: Db, w: OrgPeopleWorld) {
  const result = await runEmploymentActivations(
    db,
    cmd(),
    { tenantId: w.tenant.id },
    { clock: () => new Date('2026-10-10T01:00:00Z') },
  );
  expect(result.runs[0]).toMatchObject({ failed: [], errors: [] });
}

it.each(
  (['transfer', 'org_adjustment'] as const).flatMap((kind) =>
    (['rename-first', 'source-first'] as const).map((order) => ({ kind, order })),
  ),
)('AC-ORG-32 DEC-244② 来源删除后保留的值是意图 / 来源=$kind / 顺序=$order', async ({ kind, order }) => {
  const { db } = database();
  const w = await orgPeopleWorld(db, `dec244b${kind}${order}`);
  const org = await w.org('部门');
  const person = await w.hire('员工', { departmentId: org.id, place: '原地点' });
  let renamedId = '';
  if (order === 'rename-first') renamedId = await rename(w, org.id, person.id, '2026-10-09', '改名部门');
  const sourceBusiness = await source(w, person.id, kind, { fields: { place: SOURCE_PLACE } });
  if (order === 'source-first') renamedId = await rename(w, org.id, person.id, '2026-10-09', '改名部门');
  // 先建 F-007 时由来源向后更新写入；先建来源时由 F-007 复制前驱写入。
  expect((await w.record(renamedId, '2026-10-09')).fields.place).toBe(SOURCE_PLACE);
  await deleteBusiness(w, sourceBusiness.id);
  expect((await w.records(person.id, '2026-10-09')).some((r) => r.id === sourceBusiness.id)).toBe(false);
  // 删除时按删除前的当前值保留，不级联、不重算。
  expect((await w.record(renamedId, '2026-10-09')).fields.place).toBe(SOURCE_PLACE);
  // 无关操作一：PATCH 备注只改备注。
  await patchRemarks(w, renamedId, '无关备注');
  expect((await w.record(renamedId, '2026-10-09')).fields).toMatchObject({ place: SOURCE_PLACE, remarks: '无关备注' });
  // 无关操作二：简单迟到执行把 10-09 的调动顺延到 10-10，不碰已保留的值。
  const late = await simpleLateTransfer(w, person.id);
  await runLate(db, w);
  expect((await w.record(renamedId, '2026-10-09')).fields).toMatchObject({
    place: SOURCE_PLACE,
    departmentId: org.id,
    remarks: '无关备注',
  });
  expect((await w.records(person.id, '2026-10-10')).find((r) => r.isCurrent)).toMatchObject({
    id: late.id,
    effectiveDate: '2026-10-10',
    fields: { place: SOURCE_PLACE, remarks: '仅改备注的迟到调动' },
  });
  // 无关操作三：再次 F-007 联动整条复制保留值。
  const secondId = await rename(w, org.id, person.id, '2026-10-12', '第二次改名');
  expect((await w.record(secondId, '2026-10-12')).fields).toMatchObject({ place: SOURCE_PLACE, departmentId: org.id });
  expect((await w.record(renamedId, '2026-10-09')).fields.place).toBe(SOURCE_PLACE);
});

it.each(
  [
    { propagatedWith: true, laterInherit: false },
    { propagatedWith: false, laterInherit: true },
  ].flatMap((item) => [false, true].map((chain) => ({ ...item, chain }))),
)(
  'AC-ORG-32 DEC-244③ 历史传播按传播时继承配置固定 / 传播时继承=$propagatedWith / 之后改为=$laterInherit / 后接F-007=$chain',
  async ({ propagatedWith, laterInherit, chain }) => {
    const { db } = database();
    const w = await orgPeopleWorld(db, `dec244c${propagatedWith}${chain}`);
    const org = await w.org('部门');
    const created = await w.request('POST', '/custom-fields', {
      ifMatch: 0,
      body: { name: '传播文本', valueType: 'text', objectType: 'employment' },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const field = (await created.json()) as { id: string; revision: number };
    const setInherit = async (revision: number, inherit: boolean) => {
      const response = await w.request('PUT', `/custom-fields/${field.id}/inheritance`, {
        ifMatch: revision,
        body: { inherit },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { revision: number }).revision;
    };
    let revision = field.revision;
    const employee = await w.employee('员工');
    const hired = await w.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        fields: { employType: 'internal', departmentId: org.id, place: '原地点' },
        customFields: { [field.id]: '甲' },
      },
      employee.revision,
    );
    // 目标是显式填写同值“甲”的组织调整：其值不来自前驱复制，只能由来源传播改成“乙”。
    const adjustment = await w.business(
      employee.id,
      {
        kind: 'org_adjustment',
        mode: 'direct',
        effectiveDate: '2026-10-09',
        fields: { remarks: '显式自定义字段' },
        customFields: { [field.id]: '甲' },
      },
      (await w.getEmployee(employee.id)).revision,
    );
    const ids = [adjustment.id, ...(chain ? [await rename(w, org.id, employee.id, '2026-10-09', '改名部门')] : [])];
    for (const id of ids) expect((await w.record(id, '2026-10-09')).customFields[field.id]).toBe('甲');
    // 继承开关只在传播来源创建前切换一次：新建字段默认继承开启。来源按期在 10-07 当天保存并生效，不属迟到。
    if (!propagatedWith) revision = await setInherit(revision, false);
    w.setNow('2026-10-07T01:00:00Z');
    await source(w, employee.id, 'transfer', { fields: { remarks: '传播来源' }, customFields: { [field.id]: '乙' } });
    // 传播发生时：继承开启则目标被向后更新为乙；继承关闭则保持甲。
    const propagated = propagatedWith ? '乙' : '甲';
    for (const id of ids) expect((await w.record(id, '2026-10-09')).customFields[field.id]).toBe(propagated);
    await setInherit(revision, laterInherit);
    // 配置变更之后的无关操作：PATCH 备注、简单迟到执行，都不改写已传播的历史值。
    for (const id of ids) await patchRemarks(w, id, '无关备注');
    const late = await simpleLateTransfer(w, employee.id);
    await runLate(db, w);
    for (const id of ids)
      expect.soft((await w.record(id, '2026-10-09')).customFields[field.id], `组织调整 ${id}`).toBe(propagated);
    // 迟到调动本身是配置变更之后新建的记录：继承开着才带出历史值，关着就为空（DEC-244③ 只保护已有记录）。
    expect((await w.records(employee.id, '2026-10-10')).find((r) => r.id === late.id)).toMatchObject({
      effectiveDate: '2026-10-10',
      customFields: { [field.id]: laterInherit ? propagated : null },
    });
    expect(hired.id).toBeDefined();
  },
);

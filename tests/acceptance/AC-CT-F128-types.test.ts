/** F-128 BE-1：合同类型显示顺序与停用校验（A15）。只拦新选用，历史合同与设置里的引用不受影响。 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld, type ContractView } from './AC-CT-support.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { allowAll } from './support/tenant-api.js';
import { runContractJobs } from '../../apps/api/src/modules/contracts/scheduler.js';

const testDb = useTestDb();
type World = Awaited<ReturnType<typeof contractWorld>>;
const DISABLED = '合同类型已停用';

async function addType(w: World, code: string, displayOrder?: number) {
  const response = await w.request('POST', '/master-data/types', {
    ifMatch: 0,
    body: { code, name: `类型${code}`, ...(displayOrder === undefined ? {} : { displayOrder }) },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; revision: number; code: string; displayOrder: number };
}
async function listTypes(w: World) {
  const response = await w.request('GET', '/master-data/types');
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      items: { id: string; code: string; name: string; revision: number; displayOrder: number }[];
    }
  ).items;
}
async function disable(w: World, typeId: string) {
  const row = (await listTypes(w)).find((t) => t.id === typeId)!;
  const response = await w.request('PUT', `/master-data/types/${typeId}`, {
    ifMatch: row.revision,
    body: { code: row.code, name: row.name, enabled: false },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('AC-CT F-128 A15 类型显示顺序', () => {
  it('列表按显示顺序、再按编码排序；POST / PUT 可写显示顺序', async () => {
    const w = await contractWorld(testDb().db, 'f128-type-order');
    await addType(w, 'ZZ-3', 3);
    await addType(w, 'BB-5', 5);
    const first = await addType(w, 'AA-5', 5);
    await addType(w, 'MM-1', 1);
    const codes = (await listTypes(w)).map((t) => t.code).filter((c) => /^(ZZ|BB|AA|MM)-/.test(c));
    expect(codes).toEqual(['MM-1', 'ZZ-3', 'AA-5', 'BB-5']);
    expect(first.displayOrder).toBe(5);
    const moved = await w.request('PUT', `/master-data/types/${first.id}`, {
      ifMatch: first.revision,
      body: { code: 'AA-5', name: '类型AA-5', displayOrder: 0 },
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await moved.json()).toMatchObject({ displayOrder: 0 });
    const reordered = (await listTypes(w)).map((t) => t.code).filter((c) => /^(ZZ|BB|AA|MM)-/.test(c));
    expect(reordered).toEqual(['AA-5', 'MM-1', 'ZZ-3', 'BB-5']);
  });

  it('不带显示顺序的更新不重置已有顺序；法人公司不接受显示顺序', async () => {
    const w = await contractWorld(testDb().db, 'f128-type-order-keep');
    const type = await addType(w, 'KEEP-7', 7);
    const renamed = await w.request('PUT', `/master-data/types/${type.id}`, {
      ifMatch: type.revision,
      body: { code: 'KEEP-7', name: '改名' },
    });
    expect(await renamed.json()).toMatchObject({ displayOrder: 7, name: '改名' });
    const company = await w.request('POST', '/master-data/companies', {
      ifMatch: 0,
      body: { code: randomUUID(), name: '公司', displayOrder: 1 },
    });
    expect(company.status).toBe(400);
  });
});

describe('AC-CT F-128 A15 停用类型不可新选用', () => {
  async function disabledWorld(label: string) {
    const w = await contractWorld(testDb().db, label);
    const original = await w.create({ endDate: '2027-09-30' });
    await disable(w, w.type.id);
    return { w, original };
  }

  it('新建被拒，错误说明类型已停用', async () => {
    const { w } = await disabledWorld('f128-disabled-create');
    const response = await w.request('POST', '/commands', {
      ifMatch: 0,
      body: {
        operation: 'create',
        mode: 'direct',
        employeeId: w.employee.id,
        fields: { ...w.fields, number: 'NEW-1', effectiveDate: '2024-01-01', endDate: '2024-12-31' },
      },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(DISABLED);
  });

  it('续签被拒；变更不改类型的历史合同不受影响；改成停用类型被拒', async () => {
    const { w, original } = await disabledWorld('f128-disabled-renew');
    const renew = await w.change(original, 'renew', { effectiveDate: '2027-10-01', endDate: '2028-09-30' });
    expect(renew.status).toBe(400);
    expect(await renew.text()).toContain(DISABLED);
    const sameType = await w.change(original, 'change', { effectiveDate: '2026-10-01' });
    expect(sameType.status, await sameType.clone().text()).toBe(201);
    const enabled = await w.request('POST', '/commands', {
      ifMatch: 0,
      body: {
        operation: 'create',
        mode: 'direct',
        employeeId: w.employee.id,
        fields: {
          ...w.fields,
          typeId: w.otherType.id,
          number: 'OTHER-1',
          effectiveDate: '2024-01-01',
          endDate: '2024-12-31',
        },
      },
    });
    expect(enabled.status, await enabled.clone().text()).toBe(201);
    const switched = await w.change((await enabled.json()) as ContractView, 'change', { typeId: w.type.id });
    expect(switched.status).toBe(400);
    expect(await switched.text()).toContain(DISABLED);
  });

  it('批量与导入同样被拒；已有合同仍可列出', async () => {
    const { w, original } = await disabledWorld('f128-disabled-batch');
    const row = { ...w.fields, number: 'NEW-2', effectiveDate: '2024-01-01', endDate: '2024-12-31' };
    const batch = await w.request('POST', '/batch', {
      ifMatch: 0,
      body: {
        items: [
          { revision: 0, command: { operation: 'create', mode: 'direct', employeeId: w.employee.id, fields: row } },
        ],
      },
    });
    expect(batch.status).toBe(400);
    expect(await batch.text()).toContain(DISABLED);
    const imported = await w.request('POST', '/imports', {
      ifMatch: 0,
      body: { mode: 'add', rows: [{ employeeId: w.employee.id, fields: row }] },
    });
    expect(imported.status).toBe(400);
    expect(await imported.text()).toContain(DISABLED);
    expect((await w.list()).map((c) => c.id)).toEqual([original.id]);
  });

  it('设置里仍可引用停用类型（只是配置）', async () => {
    const { w } = await disabledWorld('f128-disabled-settings');
    await w.settings({ postExitTypeIds: [w.type.id], renewalTypeIds: [w.type.id], indefiniteTypeIds: [w.type.id] });
  });

  it('自动续签遇到停用类型 → 任务失败并可见，不产生续签申请', async () => {
    const w = await contractWorld(testDb().db, 'f128-disabled-auto');
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    await w.create({ effectiveDate: '2026-01-01', endDate: '2026-10-02' });
    await w.settings({ autoRenew: true });
    const rule = await w.request('POST', '/rules', {
      ifMatch: 0,
      body: {
        name: '续签',
        priority: 1,
        orgIds: [w.org.id],
        personIds: [],
        details: [{ typeId: w.type.id, months: 12, initiatorId: w.session.user.id, daysBefore: 10, skipTypeIds: [] }],
      },
    });
    expect(rule.status, await rule.clone().text()).toBe(201);
    await disable(w, w.type.id);
    const result = await runContractJobs(
      w.db,
      { tenantId: w.session.tenant.id },
      { clock: () => new Date('2026-10-01T01:00:00Z'), authorize: allowAll },
    );
    expect(result.runs[0]?.outcomes).toEqual([expect.objectContaining({ kind: 'renew', state: 'failed' })]);
    expect(await w.list('in_review')).toEqual([]);
  });
});

/**
 * S1-P2-04 / AC-ORG-31：控编投影只模拟真实会发生的向后更新。历史任职的编辑（单条 PATCH、批量编辑、导入编辑）与
 * 新增导入选“不向后更新”都不传播到其后的组织调整，容量判定不得把这些组织调整也投影成新部门。
 * 场景：E 在 A，10-03 调动只改地点，10-05 F-007 组织调整仍为 A；Q 自 10-06 起在 B，B 严格编制 1；
 * 10-10 把 E 的历史 10-03 记录改到 B：正确占编只有 [10-03, 10-05)，与 Q 不重叠。
 */
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

function orgApi(w: ActivationWorld) {
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  return (method: string, path: string, body: object, revision = 0) =>
    api.request(method, `/api/tenant/${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: revision,
      body,
    });
}

async function strictCapacity(w: ActivationWorld) {
  const request = orgApi(w);
  const response = await request('POST', 'establishment/schemes', {
    name: '历史编辑占编',
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2026-01-01',
    occupancyRanges: [{ employmentType: 'internal' }],
  });
  expect(response.status).toBe(201);
  const scheme = (await response.json()) as { id: string };
  const capacity = await request('POST', 'establishment/capacities', {
    orgId: w.to.id,
    schemeId: scheme.id,
    periodStart: '2026-01-01',
    localCapacity: 1,
    strictControl: true,
  });
  expect(capacity.status).toBe(201);
}

async function rename(w: ActivationWorld, effectiveDate: string) {
  const response = await orgApi(w)(
    'PATCH',
    `org/organizations/${w.from.id}`,
    { name: `${w.from.name}改名`, effectiveDate, addEmployment: true },
    w.from.revision,
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

const revisionOf = async (w: ActivationWorld, employeeId: string) => (await w.session.getEmployee(employeeId)).revision;

/** B 严格编制 1；E 在 A，10-05 有 F-007 组织调整（仍为 A）；今天 10-10，Q 自 10-06 起在 B。 */
async function scene(label: string, withHistorical = true) {
  const w = await activationWorld(database().db, label);
  await strictCapacity(w);
  const e = await w.hired('E');
  const historical = withHistorical
    ? await w.session.business(
        e.employee.id,
        { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-03', fields: { place: '三日地点' } },
        await revisionOf(w, e.employee.id),
      )
    : null;
  await rename(w, '2026-10-05');
  const adjustment = (await w.session.records(e.employee.id, '2026-10-05')).find((r) => r.kind === 'org_adjustment')!;
  expect(adjustment.fields.departmentId).toBe(w.from.id);
  w.session.setNow('2026-10-10T01:00:00Z');
  const q = await w.session.employee('Q');
  await w.session.business(
    q.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2026-10-06', fields: { departmentId: w.to.id, place: 'B 地点' } },
    q.revision,
  );
  return { w, e, historical: historical!, adjustment, q };
}

/** 历史记录改到 B，其后的组织调整不传播、仍为 A；Q 不受影响。 */
async function expectHistoricalMove(s: Awaited<ReturnType<typeof scene>>, recordId = s.historical.id) {
  expect((await s.w.session.record(recordId, '2026-10-03')).fields.departmentId).toBe(s.w.to.id);
  expect(await s.w.session.record(s.adjustment.id, '2026-10-10')).toMatchObject({
    isCurrent: true,
    fields: { departmentId: s.w.from.id },
  });
  expect((await s.w.session.records(s.q.id, '2026-10-10')).find((r) => r.isCurrent)?.fields.departmentId).toBe(
    s.w.to.id,
  );
}

it('单条 PATCH 历史任职改部门到严格控编部门：占编只到下一条组织调整，不超编（200）', async () => {
  const s = await scene('org31hist-patch');
  const current = await s.w.business(s.historical.id);
  const response = await s.w.session.request('PATCH', `/records/${s.historical.id}`, {
    ifMatch: current.revision,
    body: { fields: { departmentId: s.w.to.id } },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await expectHistoricalMove(s);
});

it('批量编辑中的历史记录：同样不投影不会发生的传播（200）', async () => {
  const s = await scene('org31hist-batch');
  const current = await s.w.business(s.historical.id);
  const response = await s.w.session.request('POST', '/records/batch-edit', {
    body: {
      items: [{ id: s.historical.id, revision: current.revision }],
      patch: { fields: { departmentId: s.w.to.id } },
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await expectHistoricalMove(s);
});

it('任职导入编辑历史记录：不产生虚假超编警告', async () => {
  const s = await scene('org31hist-import-edit');
  const current = await s.w.business(s.historical.id);
  const response = await s.w.session.request('POST', `/employees/${s.e.employee.id}/import`, {
    ifMatch: await revisionOf(s.w, s.e.employee.id),
    body: {
      items: [
        {
          operation: 'edit',
          id: s.historical.id,
          revision: current.revision,
          patch: { fields: { departmentId: s.w.to.id } },
        },
      ],
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(((await response.json()) as { warnings: unknown[] }).warnings).toEqual([]);
  await expectHistoricalMove(s);
});

it('任职新增导入选“不向后更新”：补录调入严格控编部门不产生虚假超编警告，组织调整仍为原部门', async () => {
  const s = await scene('org31hist-import-create', false);
  const response = await s.w.session.request('POST', `/employees/${s.e.employee.id}/import`, {
    ifMatch: await revisionOf(s.w, s.e.employee.id),
    body: {
      updateLaterEmployment: '否',
      items: [
        {
          operation: 'create',
          business: {
            kind: 'transfer',
            mode: 'direct',
            effectiveDate: '2026-10-03',
            fields: { departmentId: s.w.to.id, place: '补录地点' },
          },
        },
      ],
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const result = (await response.json()) as { warnings: unknown[]; items: { id: string }[] };
  expect(result.warnings).toEqual([]);
  await expectHistoricalMove(s, result.items[0]!.id);
});

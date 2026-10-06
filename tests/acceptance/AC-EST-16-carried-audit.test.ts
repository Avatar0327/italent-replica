import type { Authorizer } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { carriedWorld } from './AC-TRF-37-EST-08-support.js';
import { auditApi } from './AC-AUD-support.js';
const database = useTestDb();
let w: Awaited<ReturnType<typeof carriedWorld>>;
let businessId: string;
beforeAll(async () => {
  w = await carriedWorld(database().db, 'carried-audit');
  const saved = await w.save(await w.hired());
  expect(saved.status, await saved.clone().text()).toBe(201);
  const business = (await saved.json()) as { id: string; revision: number };
  businessId = business.id;
  const deleted = await w.session.request('DELETE', `/businesses/${business.id}`, { ifMatch: business.revision });
  expect(deleted.status, await deleted.clone().text()).toBe(200);
});
function viewer(orgIds: string[], fields: string[], view = true) {
  const authorize: Authorizer = (r) =>
    !(r.resource === MODULE_OBJECTS.establishment.code && r.action === 'object.view') || view;
  registerScopeProvider(authorize, {
    scope: async () => ({
      ...EMPTY_SCOPE,
      orgIds,
      hasDataPermission: true,
      terms: [{ dimension: 'organization', orgIds, personIds: [] }],
    }),
    authorize: async (r) => authorize(r),
    fields: async () => new Set(fields),
  });
  return auditApi(w.db, '2026-10-01T01:00:00Z', { authorize });
}
const as = () => ({ tenant: w.session.tenant.id, user: w.session.user.id });

it('AC-EST-16 增减和回退均写统一审计；有编制查看权及范围的用户可见', async () => {
  const audit = viewer([w.from.id, w.to.id], ['localCapacity']);
  for (const action of ['establishment.transfer.adjust', 'establishment.transfer.reverse']) {
    const result = await audit.dataChanges(as(), { objectType: 'establishment-capacity', action });
    expect(result.items).toHaveLength(2);
    for (const row of result.items)
      expect(row.changes).toEqual([expect.objectContaining({ field: 'capacity.localCapacity' })]);
  }
  const history = await w.history();
  expect(history).toHaveLength(4);
  expect(history.every((e) => (e.after as { businessId: string }).businessId === businessId)).toBe(true);
});

it('AC-EST-16 范围外编制日志不可列出、详情 404，撤权后立即隐藏', async () => {
  const allowed = viewer([w.from.id, w.to.id], ['localCapacity']);
  const all = await allowed.dataChanges(as(), { action: 'establishment.transfer.adjust' });
  const outside = all.items.find((r) => r.objectId === w.targetCapacity)!;
  const limited = viewer([w.from.id], ['localCapacity']);
  expect(
    (await limited.dataChanges(as(), { action: 'establishment.transfer.adjust' })).items.map((r) => r.objectId),
  ).toEqual([w.sourceCapacity]);
  expect((await limited.get(`/data-changes/${outside.id}`, as())).status).toBe(404);
  expect(
    (
      await viewer([w.from.id, w.to.id], ['localCapacity'], false).dataChanges(as(), {
        action: 'establishment.transfer.adjust',
      })
    ).items,
  ).toEqual([]);
});

it('AC-EST-16 细分数组逐字段裁剪，列表差异、渲染文本及详情不泄露隐藏职位/含下级编制', async () => {
  const audit = viewer([w.to.id], ['localCapacity', 'subdivisions']);
  const list = await audit.dataChanges(as(), { action: 'establishment.transfer.adjust' });
  expect(list.items).toHaveLength(1);
  const row = list.items[0]!;
  expect(JSON.stringify(row)).not.toContain(w.targetPosition);
  const detail = await audit.dataChange(as(), row.id);
  expect(detail.after).toEqual({ capacity: { localCapacity: 1, subdivisions: [{ localCapacity: 1 }] } });
  expect(JSON.stringify(detail)).not.toContain('inclusiveCapacity');
  expect(JSON.stringify(detail)).not.toContain(w.targetPosition);
});

it('AC-EST-16 只有隐藏的细分额度变化时，不因可见数组容器泄露事件或计数', async () => {
  const audit = viewer([w.to.id], ['subdivisions', 'positionId']);
  expect((await audit.dataChanges(as(), { action: 'establishment.transfer.adjust' })).items).toEqual([]);
  expect(
    (await audit.dataChanges(as(), { action: 'establishment.transfer.reverse', field: 'subdivisions' })).items,
  ).toEqual([]);
});

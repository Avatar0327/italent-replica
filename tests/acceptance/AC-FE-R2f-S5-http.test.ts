import { bootstrapTenantAdmin } from '@italent/api';
import {
  CONTRACT_BOARD_OBJECT,
  CONTRACT_BOARD_COMPONENTS,
  MODULE_OBJECTS,
  type ContractBoardCode,
} from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { contractDetailUrl, contractOverviewUrl } from '../../apps/web/src/hr-analytics/contract-board-model.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { CONTRACT_BOARD_BASE, TODAY, contractKit, structureWorld, type Board } from './AC-HA-13a-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const prefix = 'ZZ_FER2F_S5_';

async function json<T>(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as T;
}

it('AC-FE-R2f-01/09/11 单授 B55 的真实入口、主数据独立授权和统计范围', async () => {
  const db = database().db;
  const w = await structureWorld(db, prefix);
  const api = tenantApi(db, { authorize: undefined, clock: () => new Date(`${TODAY}T01:00:00Z`) });
  const adminRecord = await bootstrapTenantAdmin(db, { tenantId: w.tenantId, userId: w.who.user }, cmd());
  const world = { db, api, tenant: w.session.tenant, admin: w.session.user, asAdmin: w.who, adminRecord };
  const reader = await addMember(world, `${prefix}reader`);
  const denied = await addMember(world, `${prefix}denied`);
  const profile = await createProfile(world, `${prefix}board`);
  const capabilities = { dataOperations: { create: false, update: false, delete: false }, fields: [], buttons: [] };
  expect((await setObjectPermission(world, profile, capabilities, CONTRACT_BOARD_OBJECT)).status).toBe(200);
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, reader.id, profile.id)).status).toBe(201);

  const who = { tenant: w.tenantId, user: reader.id };
  const get = (path: string) => api.request('GET', path, who);
  const snapshot = await json<ServerSnapshot>(await get('/api/tenant/permission/me/snapshot'));
  expect(snapshot.apps.find(({ app }) => app === 'staff')?.entryObjects).toEqual([CONTRACT_BOARD_OBJECT]);
  const menu = menuNodes(PAGES.entries, snapshot).find(({ key }) => key === 'hr-analytics');
  expect(
    menu?.children?.map(({ key }) => key),
    'B55 单授权必须使实际数据分析目录仅显示独立合同入口',
  ).toEqual(['hr-contract-board']);

  const byCode = (board: Board, code: string) => board.components.find((item) => item.code === code);
  const overview = (query = new URLSearchParams()) =>
    get(contractOverviewUrl({ ...Object.fromEntries(query), asOf: TODAY })).then(json<Board>);
  const emptyScope = await overview();
  expect(emptyScope.hasDataPermission).toBe(false);
  expect(emptyScope.components.map(({ code }) => code)).toEqual(CONTRACT_BOARD_COMPONENTS.map(({ code }) => code));
  expect(emptyScope.components.map(({ value }) => value)).toEqual(Array(8).fill(0));
  for (const path of [
    '/api/tenant/contracts/master-data/companies',
    '/api/tenant/contracts/master-data/types',
    '/api/tenant/analytics/hr-dashboard',
    '/api/tenant/analytics/hr-structure',
  ])
    expect((await get(path)).status, path).toBe(403);
  for (const path of [CONTRACT_BOARD_BASE, `${CONTRACT_BOARD_BASE}/components/changeCreate`])
    expect((await api.request('GET', path, { ...who, user: denied.id })).status).toBe(403);

  const department = await w.org(`${prefix}department`);
  const outside = await w.org(`${prefix}outside`);
  const worker = await w.hire(`${prefix}worker`, { date: '2020-01-01', department });
  const otherWorker = await w.hire(`${prefix}other_worker`, { date: '2020-01-01', department: outside });
  const kit = await contractKit(w);
  const company = await kit.master('companies', `${prefix}company`);
  const labor = await kit.master('types', `${prefix}labor`);
  const service = await kit.master('types', `${prefix}service`);
  const fixed = { companyId: company.id, effectiveDate: '2026-01-01', endDate: '2027-12-31', termType: 'fixed' };
  const first = await kit.command({
    operation: 'create',
    employeeId: worker.id,
    fields: { ...fixed, typeId: labor.id, endDate: '2026-10-20' },
  });
  const second = await kit.command({
    operation: 'create',
    employeeId: worker.id,
    fields: { ...fixed, typeId: service.id, effectiveDate: '2026-02-01' },
  });
  await kit.command({ operation: 'create', employeeId: otherWorker.id, fields: { ...fixed, typeId: labor.id } });
  const requestIds = await kit.requestIds(worker.id, 'create');
  const scope = await api.request('PUT', `/api/tenant/permission/scopes/${reader.id}/TenantBase`, {
    ...w.who,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: department.id, includeDescendants: false }] },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);

  const board = await overview();
  expect(board.hasDataPermission).toBe(true);
  expect(byCode(board, 'changeCreate')?.value).toBe(2);
  expect(byCode(board, 'signByCompany')?.groups).toEqual([
    { key: company.id, label: `${prefix}company`, count: 1, ratio: 1 },
  ]);
  expect(byCode(board, 'signByType')?.groups?.map(({ count }) => count)).toEqual([1, 1]);
  expect(byCode(board, 'signByTermType')?.groups?.map(({ key, count }) => [key, count])).toEqual([
    ['fixed', 1],
    ['indefinite', 0],
    ['task', 0],
    ['none', 0],
  ]);

  const query = new URLSearchParams({
    changeFrom: '2026-01-01',
    changeTo: '2026-01-01',
    companyId: company.id,
    typeId: labor.id,
    termType: 'fixed',
  });
  const narrowed = await overview(query);
  expect(byCode(narrowed, 'changeCreate')?.value).toBe(1);
  const detail = (code: ContractBoardCode, params: URLSearchParams, group?: string) =>
    get(contractDetailUrl(code, { ...Object.fromEntries(params), asOf: TODAY }, 1, group)).then(
      json<{ total: number; items: { id: string; employeeId: string }[] }>,
    );
  const changes = await detail('changeCreate', query);
  expect(changes.total).toBe(1);
  expect(changes.items[0]?.id).toBeOneOf(requestIds);
  expect(changes.items[0]?.id).not.toBe(first.id);
  query.set('changeFrom', '2026-03-01');
  query.set('changeTo', '2026-12-31');
  const later = await overview(query);
  expect(byCode(later, 'changeCreate')?.value).toBe(0);
  expect(byCode(later, 'signByType')?.value).toBe(1);
  expect(byCode(later, '3.1.17')?.value).toBe(1);
  expect(await detail('signByType', query, labor.id)).toMatchObject({
    total: 1,
    items: [{ id: first.id, employeeId: worker.id }],
  });
  expect(await detail('signByTermType', new URLSearchParams(), 'fixed')).toMatchObject({
    total: 1,
    items: [{ id: second.id, employeeId: worker.id }],
  });
  expect(await detail('signByTermType', new URLSearchParams(), 'none')).toMatchObject({ total: 0, items: [] });
  expect(await detail('3.1.17', query)).toMatchObject({
    total: 1,
    items: [{ id: first.id, employeeId: worker.id }],
  });

  for (let index = 1; index <= 10; index++) {
    const extra = await kit.master('companies', `${prefix}法人${index}`);
    await kit.command({
      operation: 'create',
      employeeId: worker.id,
      fields: { ...fixed, typeId: service.id, companyId: extra.id, effectiveDate: '2025-01-01' },
    });
  }
  const top = byCode(await overview(), 'signByCompany');
  expect(top?.value).toBe(11);
  expect(top?.groups).toHaveLength(10);
  expect(top?.groups?.map(({ count, ratio }) => [count, ratio])).toEqual(Array.from({ length: 10 }, () => [1, 0.0909]));
  const firstGroup = top!.groups![0]!;
  expect(await detail('signByCompany', new URLSearchParams(), firstGroup.key)).toMatchObject({
    total: 1,
    items: [{ employeeId: worker.id }],
  });

  const candidateProfile = await createProfile(world, `${prefix}master_reader`);
  const companies = '/api/tenant/contracts/master-data/companies?page=1&pageSize=200';
  const types = '/api/tenant/contracts/master-data/types?page=1&pageSize=200';
  const choices = (path: string) => get(path).then(json<{ items: Record<string, unknown>[] }>);
  for (const [object, names] of [
    [MODULE_OBJECTS.contractCompany.code, ['id', 'name']],
    [MODULE_OBJECTS.contractType.code, ['id']],
  ] as const) {
    const view = await setObjectPermission(
      world,
      candidateProfile,
      {
        ...capabilities,
        fields: names.map((fieldCode) => ({ fieldCode, view: true, edit: false })),
      },
      object,
    );
    expect(view.status, await view.clone().text()).toBe(200);
  }
  await makeGrantable(world, [candidateProfile.id]);
  expect((await grant(world, reader.id, candidateProfile.id)).status).toBe(201);
  expect(await choices(companies)).toEqual({ items: [] });
  expect(await choices(types)).toEqual({ items: [] });
  for (const targetCode of [MODULE_OBJECTS.contractCompany.code, MODULE_OBJECTS.contractType.code]) {
    const allow = await api.request(
      'PUT',
      `/api/tenant/permission/profiles/${candidateProfile.id}/data-scopes/TenantBase`,
      {
        ...w.who,
        ifMatch: 0,
        body: { targetKind: 'entity', targetCode, seeAll: true },
      },
    );
    expect(allow.status, await allow.clone().text()).toBe(200);
  }
  expect((await choices(companies)).items).toContainEqual({ id: company.id, name: `${prefix}company` });
  expect((await choices(types)).items).toContainEqual({ id: labor.id });
  expect(byCode(await overview(), 'signByCompany')?.value).toBe(11);

  const foreign = await structureWorld(db, `${prefix}foreign`);
  for (const path of [
    CONTRACT_BOARD_BASE,
    '/api/tenant/contracts/master-data/companies',
    '/api/tenant/contracts/master-data/types',
  ])
    expect((await api.request('GET', path, { ...who, tenant: foreign.tenantId })).status, path).toBe(403);
}, 120_000);

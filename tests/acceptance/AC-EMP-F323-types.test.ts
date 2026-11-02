/** F-323（DEC-706）：人员类别租户字典、任职与兼职按 ID 引用、名称披露、启停与删除、对象授权。只用合成人员。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/errors.js';
import { validateEmploymentType } from '../../apps/api/src/modules/employment/employment-types.js';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { employmentSession, withLoginEmail } from './AC-EMP-support.js';
import type { Request } from './support/revocable-rights.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const OBJECT = 'TenantBase.EmploymentType';
interface EmploymentType {
  id: string;
  name: string;
  displayOrder: number;
  effectiveDate: string;
  expiryDate: string;
  enabled: boolean;
  revision: number;
}
const rows = <T>(v: unknown) => (Array.isArray(v) ? v : (v as { rows: T[] }).rows) as T[];

async function world(label: string) {
  const db = database().db;
  const s = await employmentSession(db, `f323-${label}`);
  const seed = () =>
    withTenant(db, s.tenant.id, (tx) =>
      installMissingSeeds(
        tx,
        { tenantId: s.tenant.id, actorUserId: null, now: new Date(), commandId: randomUUID() },
        { modules: ['employment-types'] },
      ),
    );
  await seed();
  const list = async (view = 'all') => {
    const r = await s.request('GET', `/employment-types?view=${view}`);
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as { items: EmploymentType[] }).items;
  };
  const named = async (name: string) => (await list()).find((i) => i.name === name)!;
  const org = await s.org('合成类别部门', { establishedOn: '2020-01-01' });
  const hire = async (employmentType: string | null) => {
    const e = await s.employee();
    return s.business(
      e.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: org.id, employType: 'internal', employmentType },
      },
      e.revision,
    );
  };
  const hireRaw = async (employmentType: unknown) => {
    const e = await s.employee();
    const response = await s.request('POST', `/employees/${e.id}/businesses`, {
      ifMatch: e.revision,
      body: withLoginEmail(e.id, {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: org.id, employmentType },
      }),
    });
    return { e, response };
  };
  return { db, s, seed, list, named, org, hire, hireRaw };
}

it('AC-EMP-F323-01：预置 8 条按取证（顺序号可重复、失效 9999-12-31、全部启用）；重复安装不重复', async () => {
  const w = await world('preset');
  const items = await w.list();
  expect(items).toHaveLength(8);
  const expected: [string, number, string][] = [
    ['YG正式员工', 1, '2026-05-22'],
    ['职能后台', 1, '2018-01-01'],
    ['市场运营', 2, '2018-01-01'],
    ['YG试用员工', 2, '2026-05-22'],
    ['YG校招生', 3, '2026-05-22'],
    ['技术开发', 3, '2018-01-01'],
    ['YG辞职员工', 4, '2026-05-22'],
    ['运维服务', 4, '2018-01-01'],
  ];
  for (const [name, displayOrder, effectiveDate] of expected)
    expect(items.find((i) => i.name === name)).toMatchObject({
      name,
      displayOrder,
      effectiveDate,
      expiryDate: '9999-12-31',
      enabled: true,
    });
  const orders = items.map((i) => i.displayOrder);
  expect(orders).toEqual([...orders].sort((a, b) => a - b));
  await w.seed();
  expect(await w.list()).toEqual(items);
});

it('AC-EMP-F323-02：新建（顺序号允许重复）、编辑、停用 / 启用切换视图；revision 冲突 409；日期与名称校验 400', async () => {
  const w = await world('crud');
  const input = { name: '合成类别', displayOrder: 1, effectiveDate: '2020-01-01' };
  const created = await w.s.request('POST', '/employment-types', { ifMatch: 0, body: input });
  expect(created.status, await created.clone().text()).toBe(201);
  const item = (await created.json()) as EmploymentType;
  expect(item).toMatchObject({ ...input, expiryDate: '9999-12-31', enabled: true, revision: 1 });
  const edited = await w.s.request('PUT', `/employment-types/${item.id}`, {
    ifMatch: 1,
    body: { name: '合成类别（改）', displayOrder: 3, expiryDate: '2030-12-31' },
  });
  expect(edited.status, await edited.clone().text()).toBe(200);
  expect(await edited.json()).toMatchObject({ name: '合成类别（改）', displayOrder: 3, revision: 2 });
  const stale = await w.s.request('PUT', `/employment-types/${item.id}`, { ifMatch: 1, body: { name: '过期' } });
  expect(stale.status).toBe(409);
  const disabled = await w.s.request('POST', `/employment-types/${item.id}/disable`, { ifMatch: 2 });
  expect(disabled.status, await disabled.clone().text()).toBe(200);
  expect(await disabled.json()).toMatchObject({ enabled: false, revision: 3 });
  expect((await w.list('enabled')).some((i) => i.id === item.id)).toBe(false);
  expect((await w.list('disabled')).map((i) => i.id)).toEqual([item.id]);
  expect((await w.list('all')).some((i) => i.id === item.id)).toBe(true);
  expect((await w.s.request('POST', `/employment-types/${item.id}/disable`, { ifMatch: 3 })).status).toBe(409);
  const enabled = await w.s.request('POST', `/employment-types/${item.id}/enable`, { ifMatch: 3 });
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  expect((await w.list('enabled')).some((i) => i.id === item.id)).toBe(true);
  for (const body of [
    { ...input, name: ' ' },
    { ...input, effectiveDate: '2020-02-30' },
    { ...input, effectiveDate: '2031-01-01', expiryDate: '2030-01-01' },
    { ...input, displayOrder: -1 },
    { ...input, enabled: false },
  ])
    expect((await w.s.request('POST', '/employment-types', { ifMatch: 0, body })).status).toBe(400);
  expect((await w.s.request('GET', '/employment-types?view=other')).status).toBe(400);
});

it('AC-EMP-F323-03：任职按 ID 引用并返回名称；非 UUID 400、未知 / 停用 422，失败不产生任职记录；停用后历史名称仍可读', async () => {
  const w = await world('records');
  const type = await w.named('技术开发');
  const hired = await w.hire(type.id);
  expect((await w.s.record(hired.id)).fields).toMatchObject({
    employmentType: type.id,
    employmentTypeName: '技术开发',
  });
  const text = await w.hireRaw('技术开发');
  expect(text.response.status).toBe(400);
  const unknown = await w.hireRaw(randomUUID());
  expect(unknown.response.status, await unknown.response.clone().text()).toBe(422);
  expect(await unknown.response.json()).toMatchObject({
    error: { code: 'EMPLOYMENT_TYPE_INVALID', details: { field: 'employmentType', reason: 'EMPLOYMENT_TYPE_UNKNOWN' } },
  });
  expect(await w.s.records(unknown.e.id)).toEqual([]);
  const disabled = await w.s.request('POST', `/employment-types/${type.id}/disable`, { ifMatch: type.revision });
  expect(disabled.status).toBe(200);
  const rejected = await w.hireRaw(type.id);
  expect(await rejected.response.json()).toMatchObject({
    error: { details: { reason: 'EMPLOYMENT_TYPE_DISABLED' } },
  });
  const record = await w.s.record(hired.id);
  expect(record.fields).toMatchObject({ employmentType: type.id, employmentTypeName: '技术开发' });
  const changed = await w.s.request('PATCH', `/records/${hired.id}`, {
    ifMatch: hired.revision,
    body: { fields: { employmentType: (await w.named('运维服务')).id } },
  });
  expect(changed.status, await changed.clone().text()).toBe(200);
  expect((await w.s.record(hired.id)).fields).toMatchObject({ employmentTypeName: '运维服务' });
});

it('AC-EMP-F323-04：员工表单下拉只列启用项，按任职查看权开放', async () => {
  const w = await world('options');
  const type = await w.named('YG辞职员工');
  await w.s.request('POST', `/employment-types/${type.id}/disable`, { ifMatch: type.revision });
  const r = await w.s.request('GET', '/employment-types/options');
  expect(r.status, await r.clone().text()).toBe(200);
  const items = ((await r.json()) as { items: { id: string; name: string; displayOrder: number }[] }).items;
  expect(items).toHaveLength(7);
  expect(items.some((i) => i.id === type.id)).toBe(false);
  expect(Object.keys(items[0]!).sort()).toEqual(['displayOrder', 'id', 'name']);
  const denied = tenantApi(w.db, {
    authorize: (q) => !(q.action === 'object.view' && q.resource === 'TenantBase.EmploymentRecord'),
  });
  const forbidden = await denied.request('GET', '/api/tenant/employment/employment-types/options', {
    user: w.s.user.id,
    tenant: w.s.tenant.id,
  });
  expect(forbidden.status).toBe(403);
});

it('AC-EMP-F323-05：被任职引用的类别不可删除 409；未引用的删除后各视图不再出现，补装不复活', async () => {
  const w = await world('delete');
  const used = await w.named('市场运营');
  await w.hire(used.id);
  const conflict = await w.s.request('DELETE', `/employment-types/${used.id}`, { ifMatch: used.revision });
  expect(conflict.status, await conflict.clone().text()).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { details: { reason: 'EMPLOYMENT_TYPE_IN_USE' } } });
  const free = await w.named('YG校招生');
  expect((await w.s.request('DELETE', `/employment-types/${free.id}`, { ifMatch: free.revision + 1 })).status).toBe(
    409,
  );
  const deleted = await w.s.request('DELETE', `/employment-types/${free.id}`, { ifMatch: free.revision });
  expect(deleted.status, await deleted.clone().text()).toBe(200);
  expect(await deleted.json()).toEqual({ id: free.id, deleted: true });
  for (const view of ['enabled', 'disabled', 'all'])
    expect((await w.list(view)).some((i) => i.id === free.id)).toBe(false);
  expect(
    (await w.s.request('PUT', `/employment-types/${free.id}`, { ifMatch: 2, body: { name: '复活' } })).status,
  ).toBe(404);
  expect((await w.hireRaw(free.id)).response.status).toBe(422);
  await w.seed();
  expect((await w.list()).some((i) => i.name === 'YG校招生')).toBe(false);
  const audit = rows<{ action: string; before: unknown }>(
    await withTenant(w.db, w.s.tenant.id, (tx) =>
      tx.execute(sql`SELECT action, before FROM audit_events
        WHERE tenant_id=${w.s.tenant.id} AND object_id=${free.id} AND action='employment_type.delete'`),
    ),
  );
  expect(audit[0]).toMatchObject({ action: 'employment_type.delete', before: { name: 'YG校招生' } });
});

it('AC-EMP-F323-06：兼职新增与编辑复用字典校验，详情读回名称', async () => {
  const w = await world('part-time');
  const hired = await w.hire(null);
  const type = await w.named('职能后台');
  const create = (employmentType: string) =>
    w.s.request('POST', `/employees/${hired.employeeId}/part-times`, {
      ifMatch: hired.employeeRevision,
      body: { partTimeType: 'part_time', startDate: '2026-09-10', fields: { departmentId: w.org.id, employmentType } },
    });
  expect((await create(randomUUID())).status).toBe(422);
  const response = await create(type.id);
  expect(response.status, await response.clone().text()).toBe(201);
  const record = (await response.json()) as { id: string; revision: number };
  const detail = await w.s.request('GET', `/part-times/${record.id}`);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ fields: { employmentType: type.id, employmentTypeName: '职能后台' } });
  const invalid = await w.s.request('PATCH', `/part-times/${record.id}`, {
    ifMatch: record.revision,
    body: { fields: { employmentType: randomUUID() } },
  });
  expect(invalid.status).toBe(422);
});

it('AC-EMP-F323-07：自建项只在本租户可见可写、可引用；跨租户 404 / 422，库内读不到', async () => {
  const a = await world('tenant-a');
  const b = await world('tenant-b');
  const created = await a.s.request('POST', '/employment-types', {
    ifMatch: 0,
    body: { name: '合成甲租户类别', displayOrder: 9, effectiveDate: '2020-01-01' },
  });
  expect(created.status).toBe(201);
  const item = (await created.json()) as EmploymentType;
  expect((await b.list()).some((i) => i.id === item.id)).toBe(false);
  expect((await b.s.request('PUT', `/employment-types/${item.id}`, { ifMatch: 1, body: { name: '改' } })).status).toBe(
    404,
  );
  expect((await b.s.request('POST', `/employment-types/${item.id}/disable`, { ifMatch: 1 })).status).toBe(404);
  expect((await b.s.request('DELETE', `/employment-types/${item.id}`, { ifMatch: 1 })).status).toBe(404);
  expect((await b.hireRaw(item.id)).response.status).toBe(422);
  const leaked = await withTenant(b.db, b.s.tenant.id, (tx) =>
    tx.execute(sql`SELECT id FROM employment_types WHERE tenant_id=${a.s.tenant.id}`),
  );
  expect(rows(leaked)).toEqual([]);
});

it('AC-EMP-F323-08：设置页按人员类别对象授权（查看 / 新建 / 编辑 / 停用 / 删除按钮）；字段不可见不披露名称；撤权后重放拒绝', async () => {
  const w = await world('grants');
  const type = await w.named('运维服务');
  const as = (deny: (q: Request) => boolean) => {
    const api = tenantApi(w.db, { authorize: (q) => !deny(q as Request) });
    return (
      method: string,
      path: string,
      options: { ifMatch?: number; body?: unknown; idempotencyKey?: string } = {},
    ) => api.request(method, `/api/tenant/employment${path}`, { ...options, user: w.s.user.id, tenant: w.s.tenant.id });
  };
  const button = (code: string, level: string) => (q: Request) =>
    q.action === 'object.button' && q.resource === `${OBJECT}#${code}@${level}`;
  expect(
    (await as((q) => q.action === 'object.view' && q.resource === OBJECT)('GET', '/employment-types')).status,
  ).toBe(403);
  const body = { name: '合成无权类别', displayOrder: 1, effectiveDate: '2020-01-01' };
  expect((await as(button('create', 'list'))('POST', '/employment-types', { ifMatch: 0, body })).status).toBe(403);
  expect(
    (
      await as((q) => q.action === 'object.create' && q.resource === OBJECT)('POST', '/employment-types', {
        ifMatch: 0,
        body,
      })
    ).status,
  ).toBe(403);
  const path = `/employment-types/${type.id}`;
  expect((await as(button('update', 'detail'))('PUT', path, { ifMatch: 1, body: { name: 'x' } })).status).toBe(403);
  expect((await as(button('disable', 'detail'))('POST', `${path}/disable`, { ifMatch: 1 })).status).toBe(403);
  expect((await as(button('delete', 'detail'))('DELETE', path, { ifMatch: 1 })).status).toBe(403);
  expect(
    (await as((q) => q.action === 'object.delete' && q.resource === OBJECT)('DELETE', path, { ifMatch: 1 })).status,
  ).toBe(403);
  // 命令重放按当前权限复核：首次放行，撤掉停用按钮后同键重放 403
  const key = randomUUID();
  expect((await w.s.request('POST', `${path}/disable`, { ifMatch: 1, idempotencyKey: key })).status).toBe(200);
  expect(
    (await as(button('disable', 'detail'))('POST', `${path}/disable`, { ifMatch: 1, idempotencyKey: key })).status,
  ).toBe(403);
  // 标准身份：两管理员持有全部数据操作与按钮，人事专员（无设置菜单）与经理不持有
  const grant = (code: string) =>
    STANDARD_PROFILES.find((p) => p.code === code)!.objects.find((o) => o.objectCode === OBJECT);
  for (const code of ['standard_org_system_admin', 'standard_hr_admin'])
    expect(
      grant(code)
        ?.buttons.map((b) => b.buttonCode)
        .sort(),
    ).toEqual(['create', 'delete', 'disable', 'enable', 'update']);
  expect(grant('standard_hr_specialist')).toBeUndefined();
  expect(grant('standard_manager')).toBeUndefined();
  expect(MODULE_OBJECTS.employmentType.code).toBe(OBJECT);
});

it('AC-EMP-F323-09：任职字段不可见时不披露人员类别名称', async () => {
  const w = await world('trim');
  const type = await w.named('YG试用员工');
  const hired = await w.hire(type.id);
  const { restricted } = await import('./AC-PT-http-support.js');
  const api = tenantApi(w.db, {
    authorize: restricted({ fields: ['id', 'employeeId', 'departmentId', 'revision', 'effectiveDate'] }),
  });
  const detail = await api.request('GET', `/api/tenant/employment/records/${hired.id}`, {
    user: w.s.user.id,
    tenant: w.s.tenant.id,
  });
  expect(detail.status).toBe(200);
  expect(JSON.stringify(await detail.json())).not.toContain('employmentTypeName');
});

it('AC-EMP-F323-11：审批编辑等未经 UUID 解析的入口传旧名称文本，统一 422 未知类别，不落成数据库 500', async () => {
  const w = await world('raw-name');
  const refusal = await withTenant(w.db, w.s.tenant.id, (tx) =>
    validateEmploymentType(tx, w.s.tenant.id, '技术开发').then(
      () => null,
      (error: unknown) => error,
    ),
  );
  expect(refusal).toBeInstanceOf(AppError);
  expect(refusal).toMatchObject({ code: 'EMPLOYMENT_TYPE_INVALID', details: { reason: 'EMPLOYMENT_TYPE_UNKNOWN' } });
});

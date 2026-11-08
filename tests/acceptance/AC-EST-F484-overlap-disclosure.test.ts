import type { Authorizer } from '@italent/api';
import { ESTABLISHMENT_SCHEME_DATASOURCE } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { EST_NOW, establishmentSession, type CopyJob } from './AC-EST-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const FIELDS = [
  'id',
  'orgId',
  'schemeId',
  'periodStart',
  'periodEnd',
  'revision',
  'localCapacity',
  'status',
  'capacityIds',
  'attempts',
  'failureReason',
  'reason',
  'recipientUserId',
];

/** 方案可见性：hidden=方案详情查看范围不含该方案；name-hidden=方案可见但名称字段无读权；visible=两者都有。 */
type SchemeAccess = 'hidden' | 'name-hidden' | 'visible';

async function world(label: string, access: SchemeAccess) {
  const session = await establishmentSession(testDb().db, `${label}-${uniqueSuffix()}`);
  const orgName = `披露边界部门${uniqueSuffix(12)}`;
  const org = await session.create(orgName, { establishedOn: '2026-01-01' });
  const annual = await session.scheme({ name: `年度机密方案${uniqueSuffix(12)}`, startDate: '2026-01-01' });
  const monthly = await session.scheme({
    name: `月度机密方案${uniqueSuffix(12)}`,
    periodType: 'monthly',
    startDate: '2026-01-01',
  });
  await session.capacity(org.id, annual.id);
  // 操作人对组织有编制范围；方案详情看全部按数据集单独授予（DEC-121），字段读权按对象目录
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    scope: async (query) => {
      const orgIds = [org.id];
      if (query.viewCode === ESTABLISHMENT_SCHEME_DATASOURCE && access !== 'hidden')
        return { ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' };
      return {
        ...EMPTY_SCOPE,
        hasDataPermission: true,
        orgIds,
        terms: [{ dimension: 'organization', orgIds, personIds: [] }],
      };
    },
    authorize: async (request) => authorize(request),
    fields: async () => new Set(access === 'visible' ? [...FIELDS, 'name', 'code'] : [...FIELDS, 'code']),
  });
  const api = tenantApi(testDb().db, { authorize, clock: () => EST_NOW });
  const request = (method: string, path: string, options: { ifMatch?: number; body?: unknown } = {}) =>
    api.request(method, `/api/tenant/establishment${path}`, {
      ...options,
      user: session.user.id,
      tenant: session.tenant.id,
    });
  return { session, org, orgName, annual, monthly, request };
}

type World = Awaited<ReturnType<typeof world>>;
const names = (w: World) => [w.orgName, w.annual.name, w.monthly.name];

async function overlap(w: World, schemeId: string, periodStart: string) {
  return w.request('POST', '/capacities', {
    ifMatch: 0,
    body: { orgId: w.org.id, schemeId, periodStart, localCapacity: 10, strictControl: false },
  });
}

async function runCopy(w: World): Promise<CopyJob> {
  const source = (await w.session.capacities({ orgId: w.org.id }))[0]!;
  await w.session.capacity(w.org.id, w.monthly.id, { periodStart: '2027-03-01' });
  const enqueued = await w.request('POST', '/copy-jobs', { ifMatch: 0, body: { capacityIds: [source.id] } });
  expect(enqueued.status, await enqueued.clone().text()).toBe(202);
  const pending = (await enqueued.json()) as CopyJob;
  const executed = await w.request('POST', `/copy-jobs/${pending.id}/execute`, { ifMatch: pending.revision, body: {} });
  expect(executed.status, await executed.clone().text()).toBe(200);
  return (await executed.json()) as CopyJob;
}

describe('F-484 重叠提示的披露边界（DEC-121）', () => {
  it('① 方案详情不可见：详情 404；重叠仍被拒 409，提示与响应不含方案名、组织名', async () => {
    const w = await world('f484-d-hidden', 'hidden');
    const detail = await w.request('GET', `/schemes/${w.annual.id}`);
    expect(detail.status).toBe(404);
    const denied = await overlap(w, w.monthly.id, '2026-10-01');
    const text = await denied.clone().text();
    expect(denied.status, text).toBe(409);
    expect(await denied.json()).toEqual({
      error: {
        code: 'CONFLICT',
        message: '该组织在重叠期间已有编制，不可新建，请检查',
        details: { reason: 'CAPACITY_PERIOD_OVERLAP' },
      },
    });
    for (const name of names(w)) expect(text).not.toContain(name);
    expect(await w.session.capacities({ orgId: w.org.id })).toHaveLength(1);
  });

  it('② 方案可见但名称字段不可读：详情不含 name；重叠被拒 409，提示不含名称', async () => {
    const w = await world('f484-d-name', 'name-hidden');
    const detail = await w.request('GET', `/schemes/${w.annual.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).not.toHaveProperty('name');
    const denied = await overlap(w, w.monthly.id, '2026-10-01');
    const text = await denied.clone().text();
    expect(denied.status, text).toBe(409);
    expect(await denied.json()).toMatchObject({ error: { details: { reason: 'CAPACITY_PERIOD_OVERLAP' } } });
    for (const name of names(w)) expect(text).not.toContain(name);
  });

  it('同方案同周期重复且方案不可见：沿用旧实现的通用冲突文案与 CAPACITY_EXISTS，不含名称', async () => {
    const w = await world('f484-d-same', 'hidden');
    const denied = await overlap(w, w.annual.id, '2026-01-01');
    const text = await denied.clone().text();
    expect(denied.status, text).toBe(409);
    expect(await denied.json()).toEqual({
      error: { code: 'CONFLICT', message: '该组织、方案和周期已有编制', details: { reason: 'CAPACITY_EXISTS' } },
    });
    for (const name of names(w)) expect(text).not.toContain(name);
  });

  it('③ 方案可见且名称字段可读：照旧返回 DEC-295 原文（含组织名、方案名）', async () => {
    const w = await world('f484-d-visible', 'visible');
    const detail = await w.request('GET', `/schemes/${w.annual.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ name: w.annual.name });
    const denied = await overlap(w, w.monthly.id, '2026-10-01');
    expect(denied.status, await denied.clone().text()).toBe(409);
    expect(await denied.json()).toMatchObject({
      error: {
        message: `${w.orgName}已设有10月编制，编制方案为${w.annual.name}，不可新建，请检查`,
        details: { reason: 'CAPACITY_PERIOD_OVERLAP' },
      },
    });
  });

  it.each(['hidden', 'name-hidden'] as const)(
    '④ 复制下期失败（方案 %s）：任务失败原因、报告、通知都不含方案名与组织名',
    async (access) => {
      const w = await world(`f484-d-copy-${access}`, access);
      const job = await runCopy(w);
      expect(job.status).toBe('failed');
      expect(job.failureReason).toBe('CAPACITY_PERIOD_OVERLAP: 该组织在重叠期间已有编制，不可新建，请检查');
      const report = await w.request('GET', `/copy-jobs/${job.id}/report`);
      const notices = await w.request('GET', '/notifications');
      for (const response of [report, notices]) {
        const text = await response.text();
        expect(response.status, text).toBe(200);
        for (const name of names(w)) expect(text).not.toContain(name);
      }
      expect(JSON.stringify(job)).not.toContain(w.annual.name);
      expect(JSON.stringify(job)).not.toContain(w.monthly.name);
    },
  );

  it('④ 复制下期失败（有权）：失败原因仍是 DEC-295 原文', async () => {
    const w = await world('f484-d-copy-visible', 'visible');
    const job = await runCopy(w);
    expect(job.status).toBe('failed');
    expect(job.failureReason).toContain(`${w.orgName}已设有3月编制，编制方案为${w.monthly.name}，不可新建，请检查`);
  });
});

import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { createUser, grantMembership } from '@italent/db';
import { ESTABLISHMENT_SCHEME_DATASOURCE } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { EST_NOW, establishmentSession, type CopyJob } from './AC-EST-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const FIELDS = ['id', 'orgId', 'schemeId', 'periodStart', 'periodEnd', 'revision', 'localCapacity', 'status'].concat([
  'capacityIds',
  'attempts',
  'failureReason',
  'reason',
  'recipientUserId',
  'code',
]);
const GENERIC = 'CAPACITY_PERIOD_OVERLAP: 该组织在重叠期间已有编制，不可新建，请检查';

/**
 * F-484 第 2 轮 P2-1：复制失败的文案按“读取人 / 接收人”当前权限生成，不能按执行人权限固化后再原样发给别人。
 * 创建人 creator 与执行人 executor 是同租户的两个成员，各自的方案详情 / 名称读权由 access 指定。
 */
async function world(label: string, access: { creator: boolean; executor: boolean }) {
  const session = await establishmentSession(testDb().db, `${label}-${uniqueSuffix()}`);
  const orgName = `读取人部门${uniqueSuffix(12)}`;
  const org = await session.create(orgName, { establishedOn: '2026-01-01' });
  const annual = await session.scheme({ name: `年度机密方案${uniqueSuffix(12)}`, startDate: '2026-01-01' });
  const monthly = await session.scheme({
    name: `月度机密方案${uniqueSuffix(12)}`,
    periodType: 'monthly',
    startDate: '2026-01-01',
  });
  await session.capacity(org.id, annual.id);
  await session.capacity(org.id, monthly.id, { periodStart: '2027-03-01' });
  const other = await createUser(
    testDb().db,
    { email: `reader-${randomUUID()}@example.com`, displayName: '合成创建人' },
    cmd(),
  );
  await grantMembership(testDb().db, { tenantId: session.tenant.id, userId: other.id, expectedRevision: 0 }, cmd());
  const executorId = session.user.id;
  const creatorId = other.id;
  const canName = (userId: string) => (userId === creatorId ? access.creator : access.executor);
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    scope: async (query) => {
      const orgIds = [org.id];
      if (query.viewCode === ESTABLISHMENT_SCHEME_DATASOURCE && canName(query.userId))
        return { ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' };
      return {
        ...EMPTY_SCOPE,
        hasDataPermission: true,
        orgIds,
        terms: [{ dimension: 'organization', orgIds, personIds: [] }],
      };
    },
    authorize: async (request) => authorize(request),
    fields: async (_tenantId, userId) => new Set(canName(userId) ? [...FIELDS, 'name'] : FIELDS),
  });
  const api = tenantApi(testDb().db, { authorize, clock: () => EST_NOW });
  const as =
    (userId: string) =>
    (method: string, path: string, options: { ifMatch?: number; body?: unknown } = {}) =>
      api.request(method, `/api/tenant/establishment${path}`, { ...options, user: userId, tenant: session.tenant.id });
  return { session, org, orgName, annual, monthly, creator: as(creatorId), executor: as(executorId) };
}

type World = Awaited<ReturnType<typeof world>>;
const names = (w: World) => [w.orgName, w.annual.name, w.monthly.name];
const original = (w: World) => `${w.orgName}已设有3月编制，编制方案为${w.monthly.name}，不可新建，请检查`;

/** 创建人入队、执行人执行；执行因同组织 3 月已有月度编制而业务失败。 */
async function failedByExecutor(w: World): Promise<CopyJob> {
  const source = (await w.session.capacities({ orgId: w.org.id })).find((c) => c.schemeId === w.annual.id)!;
  const enqueued = await w.creator('POST', '/copy-jobs', { ifMatch: 0, body: { capacityIds: [source.id] } });
  expect(enqueued.status, await enqueued.clone().text()).toBe(202);
  const pending = (await enqueued.json()) as CopyJob;
  const executed = await w.executor('POST', `/copy-jobs/${pending.id}/execute`, {
    ifMatch: pending.revision,
    body: {},
  });
  expect(executed.status, await executed.clone().text()).toBe(200);
  const job = (await executed.json()) as CopyJob;
  expect(job.status).toBe('failed');
  return job;
}

async function readAll(request: World['creator'], id: string) {
  const detail = await request('GET', `/copy-jobs/${id}`);
  const report = await request('GET', `/copy-jobs/${id}/report`);
  const notices = await request('GET', '/notifications');
  const out = { detail: await detail.text(), report: await report.text(), notices: await notices.text() };
  for (const [key, response] of Object.entries({ detail, report, notices })) {
    expect(response.status, `${key}: ${out[key as keyof typeof out]}`).toBe(200);
  }
  return out;
}

describe('F-484 复制失败文案按读取人 / 接收人权限生成（DEC-121，第 2 轮 P2-1）', () => {
  it('创建人无方案详情 / 名称读权、执行人有权：创建人读详情、报告、通知都不含方案名与组织名', async () => {
    const w = await world('f484-r2-creator-hidden', { creator: false, executor: true });
    const job = await failedByExecutor(w);
    // 执行人本人的执行响应按执行人权限，仍是 DEC-295 原文
    expect(job.failureReason).toBe(`CAPACITY_PERIOD_OVERLAP: ${original(w)}`);
    const seen = await readAll(w.creator, job.id);
    for (const text of Object.values(seen)) for (const name of names(w)) expect(text).not.toContain(name);
    expect(JSON.parse(seen.detail)).toMatchObject({ status: 'failed', failureReason: GENERIC });
    expect(seen.notices).toContain(GENERIC);
  });

  it('对照：执行人（有权）读任务详情与报告仍是 DEC-295 原文', async () => {
    const w = await world('f484-r2-executor-reads', { creator: false, executor: true });
    const job = await failedByExecutor(w);
    const detail = await w.executor('GET', `/copy-jobs/${job.id}`);
    expect(((await detail.json()) as CopyJob).failureReason).toBe(`CAPACITY_PERIOD_OVERLAP: ${original(w)}`);
    const report = await w.executor('GET', `/copy-jobs/${job.id}/report`);
    expect(await report.text()).toContain(original(w));
  });

  it('反向：创建人有权、执行人无权——执行响应无名称；创建人读详情、报告、通知得到原文', async () => {
    const w = await world('f484-r2-executor-hidden', { creator: true, executor: false });
    const job = await failedByExecutor(w);
    expect(JSON.stringify(job)).not.toContain(w.monthly.name);
    expect(job.failureReason).toBe(GENERIC);
    const seen = await readAll(w.creator, job.id);
    expect(JSON.parse(seen.detail).failureReason).toBe(`CAPACITY_PERIOD_OVERLAP: ${original(w)}`);
    expect(seen.report).toContain(original(w));
    expect(seen.notices).toContain(original(w));
  });
});

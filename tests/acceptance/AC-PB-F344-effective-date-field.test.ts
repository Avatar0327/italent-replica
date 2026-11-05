/**
 * F-344：转正三入口（直接转正 / 转正申请 / 批量转正）的转正日期（effectiveDate）受任职对象 editableFields 管：
 * 没有该字段编辑权的人带日期提交一律 403（整单拒绝、不落库），不带日期走服务端默认；有编辑权的人照常带日期。
 * 暂存（PUT /regularization-draft）把日期当控制项，之前不过字段校验，同在本文件补齐。
 * 前端侧见 apps/web/smoke/AC-FE-F344.smoke.spec.ts。
 */
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import {
  businessRevision,
  employeeRevision,
  hire,
  pbWorld,
  probationOf,
  type PbWorld,
  type RegularizationReceipt,
} from './AC-PB-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

const VIEWABLE = [
  'id',
  'employeeId',
  'revision',
  'employeeStatus',
  'departmentId',
  'postId',
  'kind',
  'mode',
  'status',
  'effectiveDate',
  'fields',
  'customFields',
];

/** 对象新增 / 编辑放行，但 denied 里的字段没有编辑权（授权器按载荷键判，任一不可写整单 403）。 */
function operator(
  w: PbWorld,
  staff: readonly { id: string }[],
  denied: readonly string[],
  hidden: readonly string[] = [],
) {
  const authorize: Authorizer = (request) =>
    !['object.create', 'object.update'].includes(request.action) ||
    !(request.fields ?? []).some((field) => denied.includes(field));
  const orgIds = [w.org.id];
  registerScopeProvider(authorize, {
    scope: async () => ({
      ...EMPTY_SCOPE,
      orgIds,
      hasDataPermission: true,
      terms: [{ dimension: 'organization' as const, orgIds, personIds: staff.map((employee) => employee.id) }],
    }),
    authorize: async (request) => authorize(request),
    fields: async () => new Set(VIEWABLE.filter((field) => !hidden.includes(field))),
  });
  const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00.000Z') });
  return (method: string, path: string, options: { body?: unknown; ifMatch?: number; idempotencyKey?: string } = {}) =>
    api.request(method, `/api/tenant/employment${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ...options,
    });
}

async function world(label: string, count = 1) {
  const w = await pbWorld(testDb().db, label);
  const staff = [];
  for (let index = 0; index < count; index += 1)
    staff.push((await hire(w, { months: 3, name: `转正${index}` })).employee);
  return { w, staff };
}
const items = async (w: PbWorld, ids: readonly string[]) =>
  Promise.all(ids.map(async (employeeId) => ({ employeeId, revision: await employeeRevision(w, employeeId) })));

describe('F-344 ① 直接转正：转正日期受 editableFields 管', () => {
  it('无日期编辑权带日期 → 403 且不落库；不带日期 → 200 走默认日期', async () => {
    const { w, staff } = await world('f344-direct');
    const request = operator(w, staff, ['effectiveDate']);
    const employeeId = staff[0]!.id;
    const body = { mode: 'direct', probationResult: 'normal', items: await items(w, [employeeId]) };

    const denied = await request('POST', '/regularizations', { body: { ...body, effectiveDate: '2026-10-20' } });
    expect(denied.status, await denied.clone().text()).toBe(403);
    expect((await probationOf(w, employeeId)).regularizationBusinessId).toBeNull();

    const ok = await request('POST', '/regularizations', { body });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const receipt = (await ok.json()) as RegularizationReceipt;
    expect(receipt.items[0]).toMatchObject({ status: 'succeeded', effectiveDate: '2026-12-01' });
  });

  it('有日期编辑权带日期 → 200，转正日期取所填', async () => {
    const { w, staff } = await world('f344-direct-ok');
    const request = operator(w, staff, ['lastWorkDate']);
    const body = {
      mode: 'direct',
      probationResult: 'normal',
      effectiveDate: '2026-10-20',
      items: await items(w, [staff[0]!.id]),
    };
    const ok = await request('POST', '/regularizations', { body });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(((await ok.json()) as RegularizationReceipt).items[0]).toMatchObject({
      status: 'succeeded',
      effectiveDate: '2026-10-20',
    });
  });
});

describe('F-344 ② 批量转正：转正日期受 editableFields 管', () => {
  it('无日期编辑权带统一日期 → 整单 403，一人也不办；不带日期 → 逐人走默认日期', async () => {
    const { w, staff } = await world('f344-batch', 2);
    const request = operator(w, staff, ['effectiveDate']);
    const ids = staff.map((employee) => employee.id);
    const body = { mode: 'direct', probationResult: 'normal', items: await items(w, ids) };

    const denied = await request('POST', '/regularizations', { body: { ...body, effectiveDate: '2026-10-20' } });
    expect(denied.status, await denied.clone().text()).toBe(403);
    for (const id of ids) expect((await probationOf(w, id)).regularizationBusinessId).toBeNull();

    const ok = await request('POST', '/regularizations', { body });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const receipt = (await ok.json()) as RegularizationReceipt;
    expect(receipt.items.map((item) => item.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('有日期编辑权带统一日期 → 逐人 200', async () => {
    const { w, staff } = await world('f344-batch-ok', 2);
    const request = operator(w, staff, ['lastWorkDate']);
    const body = {
      mode: 'direct',
      probationResult: 'normal',
      effectiveDate: '2026-10-20',
      items: await items(
        w,
        staff.map((employee) => employee.id),
      ),
    };
    const ok = await request('POST', '/regularizations', { body });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const receipt = (await ok.json()) as RegularizationReceipt;
    expect(receipt.items.map((item) => item.effectiveDate)).toEqual(['2026-10-20', '2026-10-20']);
  });
});

describe('F-344 ③ 转正申请：建草稿、改草稿、暂存都受 editableFields 管', () => {
  const application = { kind: 'regularization', mode: 'application', probationResult: 'normal' };

  it('建草稿：无日期编辑权带日期 → 403 不建单；不带日期 → 201 走默认日期', async () => {
    const { w, staff } = await world('f344-apply');
    const request = operator(w, staff, ['effectiveDate']);
    const employeeId = staff[0]!.id;
    const path = `/employees/${employeeId}/businesses`;

    const denied = await request('POST', path, {
      ifMatch: await employeeRevision(w, employeeId),
      body: { ...application, effectiveDate: '2026-10-20' },
    });
    expect(denied.status, await denied.clone().text()).toBe(403);

    const ok = await request('POST', path, { ifMatch: await employeeRevision(w, employeeId), body: application });
    expect(ok.status, await ok.clone().text()).toBe(201);
    expect(await ok.json()).toMatchObject({ status: 'draft', mode: 'application', effectiveDate: '2026-12-01' });
  });

  it('建草稿：有日期编辑权带日期 → 201，日期取所填', async () => {
    const { w, staff } = await world('f344-apply-ok');
    const request = operator(w, staff, ['lastWorkDate']);
    const employeeId = staff[0]!.id;
    const ok = await request('POST', `/employees/${employeeId}/businesses`, {
      ifMatch: await employeeRevision(w, employeeId),
      body: { ...application, effectiveDate: '2026-10-20' },
    });
    expect(ok.status, await ok.clone().text()).toBe(201);
    expect(await ok.json()).toMatchObject({ status: 'draft', effectiveDate: '2026-10-20' });
  });

  it('改草稿：无日期编辑权 PATCH 日期 → 403，草稿日期不变', async () => {
    const { w, staff } = await world('f344-patch');
    const employeeId = staff[0]!.id;
    const draft = await w.session.business(
      employeeId,
      { ...application, effectiveDate: '2026-10-20' },
      await employeeRevision(w, employeeId),
    );
    const request = operator(w, staff, ['effectiveDate']);
    const denied = await request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: await businessRevision(w, draft.id),
      body: { effectiveDate: '2026-10-25' },
    });
    expect(denied.status, await denied.clone().text()).toBe(403);
    const latest = await w.session.request('GET', `/businesses/${draft.id}`);
    expect(await latest.json()).toMatchObject({ effectiveDate: '2026-10-20' });
  });

  it('暂存：无日期编辑权带日期 → 403 不写暂存；只暂存试用结果 → 200；有编辑权带日期 → 200', async () => {
    const { w, staff } = await world('f344-stage');
    const employeeId = staff[0]!.id;
    const path = `/employees/${employeeId}/regularization-draft`;
    const denyDate = operator(w, staff, ['effectiveDate']);

    const denied = await denyDate('PUT', path, {
      ifMatch: 0,
      body: { effectiveDate: '2026-10-20', probationResult: 'normal' },
    });
    expect(denied.status, await denied.clone().text()).toBe(403);
    const untouched = await denyDate('GET', path);
    expect(await untouched.json()).toMatchObject({ revision: 0 });

    const withoutDate = await denyDate('PUT', path, {
      ifMatch: 0,
      body: { probationResult: 'normal' },
    });
    expect(withoutDate.status, await withoutDate.clone().text()).toBe(200);
    const revision = ((await withoutDate.json()) as { revision: number }).revision;

    const allowed = await operator(w, staff, ['lastWorkDate'])('PUT', path, {
      ifMatch: revision,
      body: { effectiveDate: '2026-10-20', probationResult: 'normal' },
    });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    expect(await allowed.json()).toMatchObject({ temporary: { effectiveDate: '2026-10-20' } });
  });
});

describe('AC-PB-F344 暂存日期字段权限返工', () => {
  it('P2-1：无编辑权携带 null → 同字段越权的 403，已有日期与 revision 不变', async () => {
    const { w, staff } = await world('f344-null');
    const path = `/employees/${staff[0]!.id}/regularization-draft`;
    const allowed = operator(w, staff, []);
    const saved = await allowed('PUT', path, {
      ifMatch: 0,
      body: { effectiveDate: '2026-10-20', probationResult: 'normal' },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const { revision } = (await saved.json()) as { revision: number };
    const denied = operator(w, staff, ['effectiveDate']);
    const response = await denied('PUT', path, {
      ifMatch: revision,
      body: { effectiveDate: null, probationResult: 'normal' },
    });
    expect.soft(response.status).toBe(403);
    expect.soft(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: '无权执行该操作' } });
    const latest = await allowed('GET', path);
    expect(latest.status).toBe(200);
    expect(await latest.json()).toMatchObject({ revision, temporary: { effectiveDate: '2026-10-20' } });
  });

  it('P2-2：无查看权 GET 裁掉日期，有查看权 GET 保留日期与暂存协议字段', async () => {
    const { w, staff } = await world('f344-read');
    const path = `/employees/${staff[0]!.id}/regularization-draft`;
    const allowed = operator(w, staff, []);
    const saved = await allowed('PUT', path, {
      ifMatch: 0,
      body: { effectiveDate: '2026-10-20', probationResult: 'normal' },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const visible = await allowed('GET', path);
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({ revision: 1, temporary: { effectiveDate: '2026-10-20' } });
    const hidden = await operator(w, staff, ['effectiveDate'], ['effectiveDate'])('GET', path);
    expect(hidden.status).toBe(200);
    const body = (await hidden.json()) as { temporary: Record<string, unknown> };
    expect(body).toMatchObject({
      id: staff[0]!.id,
      employeeId: staff[0]!.id,
      revision: 1,
      applicationId: null,
      temporary: { probationResult: 'normal', probationResultName: expect.any(String), savedAt: expect.any(String) },
    });
    expect(body.temporary).not.toHaveProperty('effectiveDate');
  });

  it('P2-2：PUT 首次回执及撤查看权后同键重放都按当前查看权裁剪', async () => {
    const { w, staff } = await world('f344-receipt');
    const path = `/employees/${staff[0]!.id}/regularization-draft`;
    const hiddenFields: string[] = ['effectiveDate'];
    const request = operator(w, staff, [], hiddenFields);
    const options = {
      ifMatch: 0,
      idempotencyKey: 'f344-receipt-current-view',
      body: { effectiveDate: '2026-10-20', probationResult: 'normal' },
    };
    const first = await request('PUT', path, options);
    expect(first.status, await first.clone().text()).toBe(200);
    expect.soft(((await first.json()) as { temporary: object }).temporary).not.toHaveProperty('effectiveDate');
    hiddenFields.length = 0;
    const visible = await request('PUT', path, options);
    expect(visible.status, await visible.clone().text()).toBe(200);
    expect(await visible.json()).toMatchObject({ revision: 1, temporary: { effectiveDate: '2026-10-20' } });
    hiddenFields.push('effectiveDate');
    const replay = await request('PUT', path, options);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(((await replay.json()) as { temporary: object }).temporary).not.toHaveProperty('effectiveDate');
  });
});

/**
 * F-347 转正申请服务端暂存与草稿四项修正（docs/02_业务建模/29 补充 DEC-709 / DEC-713）：
 * a 暂存按「转正申请 + 表单 + 员工」每人一份、覆盖写、不校验必填、不建审批单、不进我的申请，换设备同样读回；提交成功后清掉；
 * b 转正单详情带试用结果编码与保存时名称（字典改名 / 停用后不变）；
 * c 草稿 / 撤回单 PATCH 可改试用结果并同单重提；
 * e 已存草稿提交不受启用字典为空限制（新建仍要启用项）。
 */
import type { Authorizer } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import {
  businessRevision,
  draftRegularization,
  employeeRevision,
  hire,
  pbWorld,
  probationOf,
  type PbWorld,
} from './AC-PB-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

interface DraftView {
  readonly employeeId: string;
  readonly revision: number;
  readonly temporary: {
    readonly effectiveDate: string | null;
    readonly probationResult: string | null;
    readonly probationResultName: string | null;
  } | null;
  readonly applicationId: string | null;
}

const draftPath = (employeeId: string) => `/employees/${employeeId}/regularization-draft`;

async function readDraft(w: PbWorld, employeeId: string): Promise<DraftView> {
  const response = await w.session.request('GET', draftPath(employeeId));
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as DraftView;
}

async function saveDraft(w: PbWorld, employeeId: string, body: Record<string, unknown>, revision: number) {
  const response = await w.session.request('PUT', draftPath(employeeId), { ifMatch: revision, body });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as DraftView;
}

async function counts(w: PbWorld, employeeId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const [row] = rows<{ businesses: number; instances: number }>(
      await tx.execute(sql`SELECT
        (SELECT count(DISTINCT business_id)::int FROM employment_payload_versions WHERE tenant_id=${w.session.tenant.id}
          AND employee_id=${employeeId}::uuid AND kind='regularization') AS businesses,
        (SELECT count(*)::int FROM approval_instances WHERE tenant_id=${w.session.tenant.id}) AS instances`),
    );
    return row!;
  });
}

async function businessOf(w: PbWorld, id: string) {
  const response = await w.session.request('GET', `/businesses/${id}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as {
    revision: number;
    status: string;
    effectiveDate: string;
    probationResult?: string | null;
    probationResultName?: string | null;
  };
}

async function submit(w: PbWorld, id: string) {
  return w.session.request('POST', `/businesses/${id}/submit`, { ifMatch: await businessRevision(w, id), body: {} });
}

async function results(w: PbWorld) {
  const response = await w.session.request('GET', '/probation-results');
  return ((await response.json()) as { items: { id: string; code: string; revision: number }[] }).items;
}

async function changeResult(w: PbWorld, code: string, body: Record<string, unknown>) {
  const item = (await results(w)).find((entry) => entry.code === code)!;
  const response = await w.session.request('PUT', `/probation-results/${item.id}`, {
    ifMatch: item.revision,
    body,
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('F-347 a 转正申请服务端暂存（DEC-709）', () => {
  it('不校验必填即可暂存；再暂存覆盖上一份；另一会话（换设备）读回同一份；不建单、不进我的申请', async () => {
    const w = await pbWorld(testDb().db, 'f347-temp', { approval: true });
    const { employee } = await hire(w, { months: 3 });
    expect(await readDraft(w, employee.id)).toMatchObject({ employeeId: employee.id, temporary: null });
    const first = await saveDraft(w, employee.id, {}, 0);
    expect(first.temporary).toMatchObject({ effectiveDate: null, probationResult: null });
    const second = await saveDraft(
      w,
      employee.id,
      { effectiveDate: '2026-11-20', probationResult: 'early' },
      first.revision,
    );
    expect(second.revision).toBeGreaterThan(first.revision);
    // 不经本机任何存储：新的请求直接读服务端
    expect((await readDraft(w, employee.id)).temporary).toEqual({
      effectiveDate: '2026-11-20',
      probationResult: 'early',
      probationResultName: '提前转正',
      savedAt: expect.any(String),
    });
    expect(await counts(w, employee.id)).toEqual({ businesses: 0, instances: 0 });
    const initiated = await tenantApi(w.db).request('GET', '/api/tenant/approval/instances?role=initiated', {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
    });
    expect(initiated.status, await initiated.clone().text()).toBe(200);
    expect(((await initiated.json()) as { items: unknown[] }).items).toEqual([]);
    expect((await probationOf(w, employee.id)).regularizationBusinessId).toBeNull();
  });

  it('暂存 revision 不一致 409；试用结果不在字典 400；不在职 404', async () => {
    const w = await pbWorld(testDb().db, 'f347-temp-guard');
    const { employee } = await hire(w, { months: 3 });
    await saveDraft(w, employee.id, { probationResult: 'normal' }, 0);
    const stale = await w.session.request('PUT', draftPath(employee.id), { ifMatch: 0, body: {} });
    expect(stale.status).toBe(409);
    const unknown = await w.session.request('PUT', draftPath(employee.id), {
      ifMatch: 1,
      body: { probationResult: 'unknown' },
    });
    expect(unknown.status).toBe(400);
    const stranger = await w.session.employee('未入职合成员工');
    expect((await w.session.request('GET', draftPath(stranger.id))).status).toBe(404);
  });

  it('提交成功后清掉暂存；建草稿未提交时暂存仍在，草稿单经 applicationId 找回', async () => {
    const w = await pbWorld(testDb().db, 'f347-temp-submit', { approval: true });
    const { employee } = await hire(w, { months: 3 });
    await saveDraft(w, employee.id, { probationResult: 'delayed' }, 0);
    const draft = await draftRegularization(w, employee.id, '2026-12-01');
    const pending = await readDraft(w, employee.id);
    expect(pending.applicationId).toBe(draft.id);
    expect(pending.temporary).toMatchObject({ probationResult: 'delayed' });
    const submitted = await submit(w, draft.id);
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    expect(await readDraft(w, employee.id)).toMatchObject({ temporary: null, applicationId: null });
  });

  it('无转正申请按钮 403；员工不在数据范围 404（读写同一口径）', async () => {
    const w = await pbWorld(testDb().db, 'f347-temp-auth');
    const { employee } = await hire(w, { months: 3 });
    const otherOrg = await w.session.org('范围外部门', { establishedOn: '2026-01-01' });
    const outside = await hire({ ...w, org: otherOrg }, { months: 3, name: '范围外' });
    // 范围只含本部门的人（同 AC-PB-BE3-scope）；命令内复核用的 provider.authorize 与入口同一个授权器
    const call = (authorize: Authorizer, orgIds: string[]) => {
      registerScopeProvider(authorize, {
        scope: async () => ({
          ...EMPTY_SCOPE,
          orgIds,
          hasDataPermission: true,
          terms: [{ dimension: 'organization' as const, orgIds, personIds: [employee.id] }],
        }),
        authorize: async (request) => authorize(request),
        fields: async () => new Set(['effectiveDate', 'departmentId']),
      });
      const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00.000Z') });
      return (method: string, id: string) =>
        api.request(method, `/api/tenant/employment${draftPath(id)}`, {
          user: w.session.user.id,
          tenant: w.session.tenant.id,
          ifMatch: 0,
          ...(method === 'PUT' ? { body: { probationResult: 'normal' } } : {}),
        });
    };
    const noButton = call(
      (request) => !(request.action === 'object.button' && String(request.resource).includes('#Employment.Create@')),
      [w.org.id],
    );
    expect((await noButton('GET', employee.id)).status).toBe(403);
    expect((await noButton('PUT', employee.id)).status).toBe(403);
    const scoped = call(() => true, [w.org.id]);
    expect((await scoped('GET', outside.employee.id)).status).toBe(404);
    expect((await scoped('PUT', outside.employee.id)).status).toBe(404);
    const inside = await scoped('PUT', employee.id);
    expect(inside.status, await inside.clone().text()).toBe(200);
  });
});

describe('F-347 b 转正单详情带试用结果与保存时名称', () => {
  it('GET /businesses/:id 返回试用结果；字典改名、停用后仍显示保存时的名称', async () => {
    const w = await pbWorld(testDb().db, 'f347-name');
    const { employee } = await hire(w, { months: 3 });
    const draft = await draftRegularization(w, employee.id, '2026-12-01');
    expect(await businessOf(w, draft.id)).toMatchObject({ probationResult: 'normal', probationResultName: '正常转正' });
    await changeResult(w, 'normal', { name: '改名后的正常', enabled: false });
    expect(await businessOf(w, draft.id)).toMatchObject({ probationResult: 'normal', probationResultName: '正常转正' });
  });
});

describe('F-347 c 草稿 / 撤回单改试用结果并同单重提', () => {
  it('草稿 PATCH 改试用结果后提交同一张单；撤回后再改、再提交仍是同一张', async () => {
    const w = await pbWorld(testDb().db, 'f347-patch', { approval: true });
    const { employee } = await hire(w, { months: 3 });
    const draft = await draftRegularization(w, employee.id, '2026-12-01');
    const patched = await w.session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: await businessRevision(w, draft.id),
      body: { probationResult: 'early' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(await businessOf(w, draft.id)).toMatchObject({ probationResult: 'early', probationResultName: '提前转正' });
    expect((await submit(w, draft.id)).status).toBe(200);
    const withdrawn = await w.session.request('POST', `/businesses/${draft.id}/withdraw`, {
      ifMatch: await businessRevision(w, draft.id),
      body: {},
    });
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    const again = await w.session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: await businessRevision(w, draft.id),
      body: { probationResult: 'delayed', effectiveDate: '2026-12-15' },
    });
    expect(again.status, await again.clone().text()).toBe(200);
    const resubmitted = await submit(w, draft.id);
    expect(resubmitted.status, await resubmitted.clone().text()).toBe(200);
    expect(await businessOf(w, draft.id)).toMatchObject({
      status: 'in_review',
      effectiveDate: '2026-12-15',
      probationResult: 'delayed',
      probationResultName: '延期转正',
    });
    expect((await probationOf(w, employee.id)).probationResult).toBe('delayed');
    expect((await counts(w, employee.id)).businesses).toBe(1);
  });

  it('PATCH 的试用结果须为启用项（400）；非转正单不得带试用结果（400）', async () => {
    const w = await pbWorld(testDb().db, 'f347-patch-guard');
    const { employee } = await hire(w, { months: 3 });
    const draft = await draftRegularization(w, employee.id, '2026-12-01');
    await changeResult(w, 'early', { enabled: false });
    const disabled = await w.session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: await businessRevision(w, draft.id),
      body: { probationResult: 'early' },
    });
    expect(disabled.status).toBe(400);
    const transfer = await w.session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-12-01', fields: { place: '合成地点' } },
      await employeeRevision(w, employee.id),
    );
    const wrong = await w.session.request('PATCH', `/businesses/${transfer.id}`, {
      ifMatch: await businessRevision(w, transfer.id),
      body: { probationResult: 'normal' },
    });
    expect(wrong.status).toBe(400);
  });
});

describe('F-347 e 已存草稿提交不受启用字典为空限制', () => {
  it('试用结果字典全部停用后，带已存结果的草稿仍能提交；新建申请仍要启用项', async () => {
    const w = await pbWorld(testDb().db, 'f347-empty-dict', { approval: true });
    const { employee } = await hire(w, { months: 3 });
    const draft = await draftRegularization(w, employee.id, '2026-12-01');
    for (const code of ['normal', 'early', 'delayed']) await changeResult(w, code, { enabled: false });
    const submitted = await submit(w, draft.id);
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    expect(await businessOf(w, draft.id)).toMatchObject({ status: 'in_review', probationResultName: '正常转正' });
    const other = await hire(w, { months: 3, name: '另一名' });
    const created = await w.session.request('POST', `/employees/${other.employee.id}/businesses`, {
      ifMatch: await employeeRevision(w, other.employee.id),
      body: { kind: 'regularization', mode: 'application', effectiveDate: '2026-12-01', probationResult: 'normal' },
    });
    expect(created.status).toBe(400);
  });
});

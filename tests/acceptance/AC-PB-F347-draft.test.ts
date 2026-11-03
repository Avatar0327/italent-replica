/**
 * F-347 转正申请服务端暂存与草稿四项修正（docs/02_业务建模/29 补充 DEC-709 / DEC-713）：
 * a 暂存按「转正申请 + 表单 + 员工」每人一份、覆盖写、不校验必填、不建审批单、不进我的申请，换设备同样读回；提交成功后清掉；
 * b 转正单详情带试用结果编码与保存时名称（字典改名 / 停用后不变）；
 * c 草稿 / 撤回单 PATCH 可改试用结果并同单重提；
 * e 已存草稿提交不受启用字典为空限制（新建仍要启用项）。
 * 第 2 轮返工（rf347_1）：停用结果同值 PATCH、首写并发、已有申请草稿时暂存、离职后暂存、直接转正清暂存。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { sql, withTenant, type Tx } from '@italent/db';
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
import { waitForBlocked, withHeldLock } from './support/pg-interleave.js';
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

describe('AC-PB-F347 a 转正申请服务端暂存（DEC-709）', () => {
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

  it('暂存 revision 不一致 409；试用结果不在字典 400；不在职 409（DEC-788）', async () => {
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
    expect((await w.session.request('GET', draftPath(stranger.id))).status).toBe(409);
    // DEC-788：范围内非在职为 409；不存在和范围外仍同样 404，不泄露存在性。
    const notFound = async (id: string) => {
      const replies = [
        await w.session.request('GET', draftPath(id)),
        await w.session.request('PUT', draftPath(id), { ifMatch: 0, body: {} }),
      ];
      const message = async (reply: Response) => ((await reply.json()) as { error: { message: string } }).error.message;
      return Promise.all(replies.map(async (reply) => [reply.status, await message(reply)]));
    };
    const expected = [404, '员工不存在'];
    const conflict = [409, '员工非在职试用状态，不能发起转正申请'];
    expect(await notFound(stranger.id)).toEqual([conflict, conflict]);
    expect(await notFound(randomUUID())).toEqual([expected, expected]);
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
    for (const method of ['GET', 'PUT']) {
      const outsideResponse = await scoped(method, outside.employee.id);
      const missingResponse = await scoped(method, randomUUID());
      expect(outsideResponse.status).toBe(404);
      expect(missingResponse.status).toBe(outsideResponse.status);
      expect(await missingResponse.json()).toEqual(await outsideResponse.json());
    }
    const inside = await scoped('PUT', employee.id);
    expect(inside.status, await inside.clone().text()).toBe(200);
  });
});

describe('AC-PB-F347 b 转正单详情带试用结果与保存时名称', () => {
  it('GET /businesses/:id 返回试用结果；字典改名、停用后仍显示保存时的名称', async () => {
    const w = await pbWorld(testDb().db, 'f347-name');
    const { employee } = await hire(w, { months: 3 });
    const draft = await draftRegularization(w, employee.id, '2026-12-01');
    expect(await businessOf(w, draft.id)).toMatchObject({ probationResult: 'normal', probationResultName: '正常转正' });
    await changeResult(w, 'normal', { name: '改名后的正常', enabled: false });
    expect(await businessOf(w, draft.id)).toMatchObject({ probationResult: 'normal', probationResultName: '正常转正' });
  });
});

describe('AC-PB-F347 c 草稿 / 撤回单改试用结果并同单重提', () => {
  it('草稿 PATCH 改试用结果后提交同一张单；撤回后再改、再提交仍是同一张', async () => {
    const w = await pbWorld(testDb().db, 'f347-patch', { approval: true });
    const { employee } = await hire(w, { months: 3 });
    const draft = await draftRegularization(w, employee.id, '2026-12-01');
    const patched = await w.session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: await businessRevision(w, draft.id),
      body: { probationResult: 'early', effectiveDate: '2026-11-20' },
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

describe('AC-PB-F347 e 已存草稿提交不受启用字典为空限制', () => {
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

async function resultVersions(w: PbWorld, businessId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const [row] = rows<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM employment_regularization_results
        WHERE tenant_id=${w.session.tenant.id} AND business_id=${businessId}::uuid`),
    );
    return row!.n;
  });
}

async function storedDraft(w: PbWorld, employeeId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    rows<{ revision: number; saved: boolean; effective_date: string | null }>(
      await tx.execute(sql`SELECT revision, saved, effective_date::text AS effective_date
        FROM employment_regularization_drafts
        WHERE tenant_id=${w.session.tenant.id} AND employee_id=${employeeId}::uuid`),
    ),
  );
}

describe('AC-PB-F347 第 2 轮：结果停用、并发、申请草稿、离职、直接转正', () => {
  it('撤回单的结果已停用：同值（大小写、空白不同）只改日期 200 且不追加结果版本；新选停用项仍 400', async () => {
    const w = await pbWorld(testDb().db, 'f347-r2-disabled-same');
    const { employee } = await hire(w, { months: 3 });
    const draft = await draftRegularization(w, employee.id, '2026-12-01');
    const before = await resultVersions(w, draft.id);
    await changeResult(w, 'normal', { enabled: false });
    const patched = await w.session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: await businessRevision(w, draft.id),
      body: { effectiveDate: '2026-12-15', probationResult: ' NORMAL ' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(await businessOf(w, draft.id)).toMatchObject({
      effectiveDate: '2026-12-15',
      probationResult: 'normal',
      probationResultName: '正常转正',
    });
    expect(await resultVersions(w, draft.id)).toBe(before);
    await changeResult(w, 'early', { enabled: false });
    const disabled = await w.session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: await businessRevision(w, draft.id),
      body: { probationResult: 'early' },
    });
    expect(disabled.status).toBe(400);
    expect(await resultVersions(w, draft.id)).toBe(before);
  });

  it('A 打开表单后 B 建了申请草稿单：A 再暂存 409（REVISION_CONFLICT），暂存不写；A 重读看到 B 的申请单', async () => {
    const w = await pbWorld(testDb().db, 'f347-r2-pending');
    const { employee } = await hire(w, { months: 3 });
    const opened = await readDraft(w, employee.id);
    expect(opened).toMatchObject({ revision: 0, temporary: null, applicationId: null });
    const application = await draftRegularization(w, employee.id, '2026-12-01');
    const stale = await w.session.request('PUT', draftPath(employee.id), {
      ifMatch: opened.revision,
      body: { effectiveDate: '2026-11-20' },
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('REVISION_CONFLICT');
    expect(await storedDraft(w, employee.id)).toEqual([]);
    expect(await readDraft(w, employee.id)).toMatchObject({ temporary: null, applicationId: application.id });
  });

  it('离职已生效：暂存读写都 409（DEC-788），已有暂存不变', async () => {
    const w = await pbWorld(testDb().db, 'f347-r2-left');
    const { employee } = await hire(w, { months: 3 });
    await saveDraft(w, employee.id, { effectiveDate: '2026-12-01' }, 0);
    await w.session.business(
      employee.id,
      { kind: 'leave', mode: 'direct', effectiveDate: '2026-09-25', lastWorkDate: '2026-09-24' },
      await employeeRevision(w, employee.id),
    );
    expect((await w.session.request('GET', draftPath(employee.id))).status).toBe(409);
    const write = await w.session.request('PUT', draftPath(employee.id), { ifMatch: 1, body: {} });
    expect(write.status).toBe(409);
    expect(await storedDraft(w, employee.id)).toEqual([{ revision: 1, saved: true, effective_date: '2026-12-01' }]);
  });

  it('直接转正与提交申请同一清暂存入口、同一事务：转正成功后暂存清掉', async () => {
    const w = await pbWorld(testDb().db, 'f347-r2-direct');
    const { employee } = await hire(w, { months: 3 });
    await saveDraft(w, employee.id, { probationResult: 'early' }, 0);
    const direct = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: await employeeRevision(w, employee.id),
      body: { kind: 'regularization', mode: 'direct', effectiveDate: '2026-12-01', probationResult: 'normal' },
    });
    expect(direct.status, await direct.clone().text()).toBe(201);
    expect(await storedDraft(w, employee.id)).toEqual([{ revision: 2, saved: false, effective_date: null }]);
  });

  // 屏障：BEFORE INSERT 触发器等测试会话持有的咨询锁，两个请求都已读到“没有暂存行”后才写（rf347_1 P2-2 的探针）
  it.runIf(!!process.env.TEST_DATABASE_URL)(
    '首次暂存两个请求都带 If-Match 0：一个 200、一个 409，落库为成功那份',
    async () => {
      const w = await pbWorld(testDb().db, 'f347-r2-first-race');
      const { employee } = await hire(w, { months: 3 });
      await w.db.execute(
        sql.raw(`CREATE FUNCTION f347_r2_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(734734); RETURN NEW; END $$`),
      );
      await w.db.execute(
        sql.raw(`CREATE TRIGGER f347_r2_gate BEFORE INSERT ON employment_regularization_drafts
      FOR EACH ROW EXECUTE FUNCTION f347_r2_gate()`),
      );
      try {
        const put = (effectiveDate: string) =>
          w.session.request('PUT', draftPath(employee.id), { ifMatch: 0, body: { effectiveDate } });
        const take = (tx: Tx) => tx.execute(sql`SELECT pg_advisory_xact_lock(734734)`);
        const pending = await withHeldLock(
          { run: (fn) => withTenant(w.db, w.session.tenant.id, fn), take },
          async (lock) => {
            const first = lock.track(put('2026-12-01'));
            await waitForBlocked(w.db, 1);
            const second = lock.track(put('2026-12-15'));
            await waitForBlocked(w.db, 2);
            return [first, second];
          },
        );
        const replies = await Promise.all(pending);
        expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
        const winner = replies.find((reply) => reply.status === 200)!;
        const saved = ((await winner.json()) as DraftView).temporary!.effectiveDate;
        expect(await storedDraft(w, employee.id)).toEqual([{ revision: 1, saved: true, effective_date: saved }]);
      } finally {
        await w.db.execute(sql.raw('DROP TRIGGER f347_r2_gate ON employment_regularization_drafts'));
        await w.db.execute(sql.raw('DROP FUNCTION f347_r2_gate()'));
      }
    },
  );
});

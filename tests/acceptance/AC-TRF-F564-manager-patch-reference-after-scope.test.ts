/**
 * F-564 第 2 轮（审查 P2-1）：纯经理（Transfer.Manager、无 Transfer.Hr）编辑 / 提交调动草稿时，
 * 经理参照检查（requireManagerBusinessReferences，403「调动参照不在可选范围」）必须排在业务写范围复核之后。
 *
 * 场景：「不限制目标部门」关闭；经理负责原部门 A 与目标部门 B，草稿的目标部门是 B。管理员收回经理对 B 的数据范围，
 * 保留 A 的范围与经理权限：草稿（目标部门 B）已在经理的业务写范围之外。
 *   修前：参照检查（含 transferBusinessContext 的入口与命令内两处）先抛 403，经理能借它区分“范围外”与“不存在”；
 *   修后：范围外一律 404「任职业务不存在」，响应与不存在的单据逐项一致；范围内参照不合格仍是 403。
 * 覆盖：入口、首次执行、同键重放、失败回查（四处共用同一 CommandGuard，缓存回执之前先复核）。
 * 时序用 runCommand 前置钩子在“入口之后、命令事务之前”制造；失败回查用事务计数代理在“主事务回滚之后、回查事务之前”制造，
 * PGlite 与 PostgreSQL 都跑，不依赖行锁等待。范围收回用真实的管理员写入口。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Commands from '../../apps/api/src/commands.js';
import { approvalWorld, permissionAdmin } from './AC-APV-support.js';
import { createProfile, setObjectPermission } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const hooks = vi.hoisted(() => ({
  /** 命令（runCommand）开始前执行一次：入口已放行、命令事务还没开。 */
  beforeCommand: undefined as undefined | (() => Promise<void>),
  /** 让主事务在守卫通过后失败（执行体抛错），并在回查事务开始前执行一次。 */
  beforeRecheck: undefined as undefined | (() => Promise<void>),
  fired: 0,
  rechecked: 0,
}));
vi.mock('../../apps/api/src/commands.js', async (importOriginal) => {
  const original = await importOriginal<typeof Commands>();
  return {
    ...original,
    runCommand: async (...args: Parameters<typeof original.runCommand>) => {
      const hook = hooks.beforeCommand;
      hooks.beforeCommand = undefined;
      if (hook) {
        hooks.fired += 1;
        await hook();
      }
      const recheck = hooks.beforeRecheck;
      if (!recheck) return original.runCommand(...args);
      hooks.beforeRecheck = undefined;
      const [db, ctx, command] = args;
      let transactions = 0;
      // 第 1 个事务是主事务（守卫通过、执行体失败回滚）；第 2 个是失败回查事务（ledgerExit 先过守卫再查台账）。
      const counted = new Proxy(db, {
        get(target, prop) {
          if (prop !== 'transaction') return Reflect.get(target, prop, target);
          return async (...a: Parameters<typeof target.transaction>) => {
            transactions += 1;
            if (transactions === 2) {
              hooks.rechecked += 1;
              await recheck();
            }
            return target.transaction(...a);
          };
        },
      });
      return original.runCommand(counted, ctx, {
        ...command,
        execute: async () => {
          throw new Error('合成主事务失败');
        },
      });
    },
  };
});

const database = useTestDb();
afterEach(() => {
  hooks.beforeCommand = undefined;
  hooks.beforeRecheck = undefined;
  hooks.fired = 0;
  hooks.rechecked = 0;
});

const BASE = '/api/tenant/employment';
const formId = 'TenantBase.TransferMultiFormView';
const LATER = '2026-11-05';

/** 与 AC-TRF-41-42 第三轮同型夹具：经理是 A、B 的负责人，数据范围含 A、B；员工在 A，目标部门 B。 */
async function fixture(label: string) {
  const w = await approvalWorld(database().db, `f564-${label}-${uniqueSuffix()}`);
  w.setNow('2026-10-01T01:00:00Z');
  const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
  const a = await w.org('负责组织 A');
  const b = await w.org('负责组织 B');
  const manager = await w.person('纯经理', a);
  const employee = await w.person('申请员工', a);
  await w.setOrgRoles(a, { head: manager.employeeId });
  await w.setOrgRoles(b, { head: manager.employeeId });
  const actor = w.as(manager.userId);
  const admin = await permissionAdmin(w);
  const profile = await createProfile(admin, 'department_manager_self_service');
  const definition = MODULE_OBJECTS.employmentRecord;
  const configured = await setObjectPermission(
    admin,
    profile,
    {
      dataOperations: { create: true, update: true, delete: false },
      fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
      buttons: ['Transfer.Manager', 'Employment.Preview', 'Employment.Submit', 'Employment.Edit'].map((buttonCode) => ({
        buttonCode,
        level: 'detail' as const,
      })),
    },
    definition.code,
  );
  expect(configured.status).toBe(200);
  const personPermission = await setObjectPermission(
    admin,
    profile,
    {
      dataOperations: { create: false, update: false, delete: false },
      fields: MODULE_OBJECTS.employee.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
      buttons: [],
    },
    MODULE_OBJECTS.employee.code,
  );
  expect(personPermission.status).toBe(200);
  let scopeRevision = 0;
  const setScope = async (orgIds: readonly string[]) => {
    const response = await admin.api.request('PUT', `/api/tenant/permission/scopes/${manager.userId}/TenantBase`, {
      ...admin.asAdmin,
      ifMatch: scopeRevision,
      body: { kind: 'org_range', orgRanges: orgIds.map((orgId) => ({ orgId, includeDescendants: true })) },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    scopeRevision += 1;
  };
  await setScope([a, b]);
  // 关闭「不限制目标部门」：目标部门没有 Switch 31 例外，B 一旦出了经理的数据范围，草稿就在业务写范围之外。
  const settings = await w.request(w.hr.id, 'PUT', `${BASE}/transfers/settings`, {
    ifMatch: 0,
    body: { unrestrictTargetDepartment: false, autoPopulate: false },
  });
  expect(settings.status, await settings.clone().text()).toBe(200);
  await w.publishedProcess({ nodes: [{ key: 'owner', approver: { type: 'custom_variable', value: 'owner' } }] });
  const revision = async () =>
    (await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', `${BASE}/employees/${employee.employeeId}`)))
      .revision;
  const body = (initiator: 'manager' | 'hr') => ({
    initiator,
    transferTypeCode: 'in_department',
    formId,
    effectiveDate: '2026-11-01',
    mode: 'application',
    fields: { departmentId: b },
  });
  const draftByManager = async () =>
    w.json<{ id: string; revision: number }>(
      await api.request('POST', `${BASE}/transfers/employees/${employee.employeeId}`, {
        ...actor,
        ifMatch: await revision(),
        body: body('manager'),
      }),
      201,
    );
  const draftByHr = async () =>
    w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `${BASE}/transfers/employees/${employee.employeeId}`, {
        ifMatch: await revision(),
        body: body('hr'),
      }),
      201,
    );
  const patch = (id: string, revisionNo: number, key: string, fields: object = { effectiveDate: LATER }) =>
    api.request('PATCH', `${BASE}/businesses/${id}`, {
      ...actor,
      ifMatch: revisionNo,
      body: fields,
      idempotencyKey: key,
    });
  const submit = (id: string, revisionNo: number, key: string) =>
    api.request('POST', `${BASE}/businesses/${id}/submit`, {
      ...actor,
      ifMatch: revisionNo,
      body: {},
      idempotencyKey: key,
    });
  const missing = '00000000-0000-4000-8000-0000000f5640';
  return {
    ...w,
    a,
    b,
    setScope,
    draftByManager,
    draftByHr,
    patch,
    submit,
    missing,
    revokeTargetScope: () => setScope([a]),
    stable: async (id: string) => {
      const shown = await w.business(id);
      return { revision: shown.revision, status: shown.status, fields: shown.fields };
    },
  };
}
type World = Awaited<ReturnType<typeof fixture>>;

/** 响应的全部可比项：状态码、内容类型与整个 JSON 体（含错误码、中文提示与详情）；剔除按请求变化的追踪标识。 */
async function shape(response: Response) {
  const text = await response.clone().text();
  const body = JSON.parse(text) as { error?: Record<string, unknown> } & Record<string, unknown>;
  const { requestId: _requestId, traceId: _traceId, ...error } = body.error ?? {};
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: { ...body, ...(body.error ? { error } : {}) },
  };
}

/** 与不存在的单据对照：同一经理、同一请求体，换成不存在的单据 ID。 */
async function expectNotFoundLikeMissing(
  w: World,
  response: Response,
  call: (id: string, key: string) => Promise<Response>,
) {
  expect(response.status, await response.clone().text()).toBe(404);
  const absent = await call(w.missing, `miss-${uniqueSuffix()}`);
  expect(absent.status, await absent.clone().text()).toBe(404);
  expect(await shape(response)).toEqual(await shape(absent));
  expect((await shape(response)).body).toMatchObject({ error: { code: 'NOT_FOUND' } });
}

describe.each([
  ['经理发起的草稿', (w: World) => w.draftByManager()],
  ['HR 发起的草稿', (w: World) => w.draftByHr()],
])('AC-TRF-F564 纯经理编辑草稿：参照检查排在业务写范围复核之后（%s）', (_name, makeDraft) => {
  it('①入口：目标部门范围已收回 → 404，与不存在的单据逐项一致，单据不变', async () => {
    const w = await fixture('entry');
    const saved = await makeDraft(w);
    const before = await w.stable(saved.id);
    await w.revokeTargetScope();
    const response = await w.patch(saved.id, saved.revision, `k1-${uniqueSuffix()}`);
    await expectNotFoundLikeMissing(w, response, (id, key) => w.patch(id, saved.revision, key));
    expect(await w.stable(saved.id)).toEqual(before);
  });

  it('②首次执行：入口放行后、命令事务前收回目标部门范围 → 404，与不存在的单据逐项一致，单据不变', async () => {
    const w = await fixture('first');
    const saved = await makeDraft(w);
    const before = await w.stable(saved.id);
    hooks.beforeCommand = w.revokeTargetScope;
    const response = await w.patch(saved.id, saved.revision, `k2-${uniqueSuffix()}`);
    expect(hooks.fired, '钩子没有在入口之后、命令之前触发，夹具没有走到目标窗口').toBe(1);
    await expectNotFoundLikeMissing(w, response, (id, key) => w.patch(id, saved.revision, key));
    expect(await w.stable(saved.id)).toEqual(before);
  });

  it('③同键重放：首次 PATCH 已成功，之后收回目标部门范围 → 重放 404，不回缓存回执', async () => {
    const w = await fixture('replay');
    const saved = await makeDraft(w);
    const key = `k3-${uniqueSuffix()}`;
    const first = await w.patch(saved.id, saved.revision, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const after = await w.stable(saved.id);
    hooks.beforeCommand = w.revokeTargetScope;
    const replay = await w.patch(saved.id, saved.revision, key);
    expect(hooks.fired).toBe(1);
    await expectNotFoundLikeMissing(w, replay, (id, k) => w.patch(id, saved.revision, k));
    expect(await w.stable(saved.id)).toEqual(after);
  });

  it('④失败回查：主事务失败回滚后收回目标部门范围 → 回查 404，不是 403，也不是原错误', async () => {
    const w = await fixture('recheck');
    const saved = await makeDraft(w);
    const before = await w.stable(saved.id);
    hooks.beforeRecheck = w.revokeTargetScope;
    const response = await w.patch(saved.id, saved.revision, `k4-${uniqueSuffix()}`);
    expect(hooks.rechecked, '失败回查事务没有开启，夹具没有走到回查窗口').toBe(1);
    await expectNotFoundLikeMissing(w, response, (id, key) => w.patch(id, saved.revision, key));
    expect(await w.stable(saved.id)).toEqual(before);
  });

  it('⑤对照：失败回查里范围没收回 → 回查放行、台账无记录，仍是原错误（证明夹具确实走到了回查）', async () => {
    const w = await fixture('recheck-control');
    const saved = await makeDraft(w);
    hooks.beforeRecheck = async () => undefined;
    const response = await w.patch(saved.id, saved.revision, `k5-${uniqueSuffix()}`);
    expect(hooks.rechecked).toBe(1);
    expect(response.status, await response.clone().text()).toBe(500);
  });

  it('⑥正例：范围内参照不合格（B 的负责关系被撤）→ 仍是 403「调动参照不在可选范围」，单据不变', async () => {
    const w = await fixture('in-scope');
    const saved = await makeDraft(w);
    const before = await w.stable(saved.id);
    await w.setOrgRoles(w.b, { head: null });
    const response = await w.patch(saved.id, saved.revision, `k6-${uniqueSuffix()}`);
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await shape(response)).toMatchObject({
      body: { error: { code: 'FORBIDDEN', message: '调动参照不在可选范围' } },
    });
    expect(await w.stable(saved.id)).toEqual(before);
  });

  it('⑦正例：命令事务前才撤 B 的负责关系（范围仍在）→ 命令内同样 403，不是 404', async () => {
    const w = await fixture('in-scope-command');
    const saved = await makeDraft(w);
    const before = await w.stable(saved.id);
    hooks.beforeCommand = () => w.setOrgRoles(w.b, { head: null });
    const response = await w.patch(saved.id, saved.revision, `k7-${uniqueSuffix()}`);
    expect(hooks.fired).toBe(1);
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await shape(response)).toMatchObject({
      body: { error: { code: 'FORBIDDEN', message: '调动参照不在可选范围' } },
    });
    expect(await w.stable(saved.id)).toEqual(before);
  });

  it('⑧正例：范围内、参照合格 → 合法 PATCH 200，生效日已更新', async () => {
    const w = await fixture('legal');
    const saved = await makeDraft(w);
    hooks.beforeCommand = async () => undefined;
    const response = await w.patch(saved.id, saved.revision, `k8-${uniqueSuffix()}`);
    expect(hooks.fired).toBe(1);
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await w.stable(saved.id)).revision).toBe(saved.revision + 1);
  });

  it('⑨同根因：提交（同一参照检查）入口与首次执行都先复核业务写范围 → 404，与不存在的单据一致，草稿不变', async () => {
    const entry = await fixture('submit-entry');
    const savedEntry = await makeDraft(entry);
    const beforeEntry = await entry.stable(savedEntry.id);
    await entry.revokeTargetScope();
    const atEntry = await entry.submit(savedEntry.id, savedEntry.revision, `k9a-${uniqueSuffix()}`);
    await expectNotFoundLikeMissing(entry, atEntry, (id, key) => entry.submit(id, savedEntry.revision, key));
    expect(await entry.stable(savedEntry.id)).toEqual(beforeEntry);

    const first = await fixture('submit-first');
    const savedFirst = await makeDraft(first);
    const beforeFirst = await first.stable(savedFirst.id);
    hooks.beforeCommand = first.revokeTargetScope;
    const inCommand = await first.submit(savedFirst.id, savedFirst.revision, `k9b-${uniqueSuffix()}`);
    expect(hooks.fired).toBe(1);
    await expectNotFoundLikeMissing(first, inCommand, (id, key) => first.submit(id, savedFirst.revision, key));
    expect(await first.stable(savedFirst.id)).toEqual(beforeFirst);
  });
});

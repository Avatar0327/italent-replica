/**
 * PR #53 第二轮 P3：生效失败待办与 HR 重试的权限负例（AGENTS.md §10「权限」：每次请求在服务端重验、读取按当前权限裁剪）。
 * 授权钩子为测试替身：按钮权限、数据范围、可见字段分别可控；真实授权器复用同一套 requireEmploymentWrite /
 * 范围谓词 / 字段裁剪。另验平台手动入口的参数边界。
 */
import { randomUUID } from 'node:crypto';
import { registerEmploymentActivationChecks, runEmploymentActivations, type Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { errorCode, tenantApi } from './support/tenant-api.js';
import { activationWorld, type ActivationTodo, type ActivationWorld } from './AC-TRF-activation-support.js';

const testDb = useTestDb();

const fullDepartments = new Set<string>();
registerEmploymentActivationChecks({
  establishmentExceeded: async (_tx, _ctx, target) => fullDepartments.has(target.departmentId ?? ''),
});

interface Grant {
  readonly retryButton?: boolean;
  readonly orgIds?: readonly string[];
  readonly fields?: readonly string[];
}

/** 受限 HR：没有重试按钮 / 数据范围只含部分组织 / 只看部分字段；其余放行。 */
function restrictedApi(w: ActivationWorld, grant: Grant) {
  const authorize: Authorizer = (request) =>
    grant.retryButton !== false ||
    !(request.action === 'object.button' && String(request.resource).includes('Employment.RetryActivation'));
  registerScopeProvider(authorize, {
    scope: async () =>
      grant.orgIds
        ? {
            ...EMPTY_SCOPE,
            orgIds: grant.orgIds,
            hasDataPermission: true,
            terms: [{ dimension: 'organization' as const, orgIds: grant.orgIds, personIds: [] }],
          }
        : { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
    authorize: async (request) => authorize(request),
    fields: async () =>
      new Set(grant.fields ?? ['id', 'employeeId', 'kind', 'effectiveDate', 'status', 'revision', 'activation']),
  });
  const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-06T02:00:00Z') });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  return {
    retry: (business: { id: string; revision: number }, idempotencyKey?: string) =>
      api.request('POST', `/api/tenant/employment/businesses/${business.id}/activation/retry`, {
        ...as,
        ifMatch: business.revision,
        body: {},
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
    todos: async () => {
      const response = await api.request('GET', '/api/tenant/employment/activation-todos', as);
      expect(response.status).toBe(200);
      return ((await response.json()) as { items: Partial<ActivationTodo>[] }).items;
    },
  };
}

async function failedTransfer(label: string) {
  const w = await activationWorld(testDb().db, label);
  const { employee } = await w.hired();
  const approved = await w.approve(
    await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
    '2026-10-02T02:00:00Z',
  );
  fullDepartments.add(w.to.id);
  expect((await w.runScheduler('2026-10-04T17:15:00Z')).failed).toEqual([approved.id]);
  fullDepartments.delete(w.to.id);
  return { w, employee, failed: await w.business(approved.id) };
}

describe('AC-TRF-31 权限负例：重试按钮、撤权后重放、待办范围与字段裁剪', () => {
  it('没有重试按钮：403，申请仍为生效失败，失败次数不变', async () => {
    const { w, failed } = await failedTransfer('trf31-no-button');
    const response = await restrictedApi(w, { retryButton: false }).retry(failed);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('FORBIDDEN');
    expect(await w.business(failed.id)).toMatchObject({
      status: 'approved',
      revision: failed.revision,
      activation: { status: 'failed', failureCount: 1 },
    });
  });

  it('撤权后用原命令 ID 重放：先重验当前权限，403，不回放首次结果', async () => {
    const { w, failed } = await failedTransfer('trf31-revoked-replay');
    const key = randomUUID();
    const first = await restrictedApi(w, {}).retry(failed, key);
    expect(first.status).toBe(200);
    const replay = await restrictedApi(w, { retryButton: false }).retry(failed, key);
    expect(replay.status).toBe(403);
    const again = await restrictedApi(w, {}).retry(failed, key);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: failed.id, status: 'effective' });
  });

  it('待办按当前数据范围裁剪：范围外的调入部门看不到；范围内可见', async () => {
    const { w, failed } = await failedTransfer('trf31-todo-scope');
    expect(await restrictedApi(w, { orgIds: [w.from.id] }).todos()).toEqual([]);
    expect((await restrictedApi(w, { orgIds: [w.to.id] }).todos()).map((todo) => todo.id)).toEqual([failed.id]);
  });

  it('待办按当前可见字段裁剪：只返回可见字段与生效结果', async () => {
    const { w, failed } = await failedTransfer('trf31-todo-fields');
    const [todo] = await restrictedApi(w, { fields: ['id', 'employeeId', 'activation'] }).todos();
    expect(Object.keys(todo!).sort()).toEqual(['activation', 'employeeId', 'id']);
    expect(todo).toMatchObject({
      id: failed.id,
      activation: { status: 'failed', failureReason: 'ESTABLISHMENT_EXCEEDED' },
    });
  });
});

describe('平台手动入口的边界', () => {
  it('非法命令 ID、未指定租户的续跑游标、越界处理量一律拒绝，不运行任何租户', async () => {
    const { db } = testDb();
    await expect(runEmploymentActivations(db, { actorUserId: null, commandId: 'bad id!' })).rejects.toThrow(TypeError);
    const meta = () => ({ actorUserId: null, commandId: randomUUID() });
    await expect(runEmploymentActivations(db, meta(), { cursor: randomUUID() })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(runEmploymentActivations(db, meta(), { limit: 0 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(runEmploymentActivations(db, meta(), { tenantId: 'not-a-uuid' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await runEmploymentActivations(db, meta(), { tenantId: randomUUID() })).toEqual({ runs: [] });
  });
});

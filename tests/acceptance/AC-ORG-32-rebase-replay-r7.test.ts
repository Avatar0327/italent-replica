/** astra R6-P2-04：迟到重建事件属于联动改写，受限范围 HR 的合法重试与幂等重放按 DEC-177 / 178 复查。 */
import { randomUUID } from 'node:crypto';
import { registerEmploymentActivationChecks, type Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { versions } from './AC-JOB-sequence-support.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const ACTUAL = '2026-10-10T02:00:00Z';
const fullDepartments = new Set<string>();
registerEmploymentActivationChecks({
  establishmentExceeded: async (_tx, _ctx, target) => fullDepartments.has(target.departmentId ?? ''),
});

/** 只有调入部门 B 范围的 HR（组织维度：记录部门或员工当前部门在范围内，DEC-177）；按钮与字段均放行。 */
function scopedApi(w: ActivationWorld, orgIds: readonly string[] | 'all') {
  const authorize: Authorizer = () => true;
  const tenantId = w.session.tenant.id;
  registerScopeProvider(authorize, {
    scope: async () =>
      orgIds === 'all'
        ? { ...EMPTY_SCOPE, all: true, hasDataPermission: true }
        : {
            ...EMPTY_SCOPE,
            orgIds,
            hasDataPermission: true,
            terms: [
              {
                dimension: 'organization',
                orgIds,
                personIds: [],
                personQuery: { kind: 'organization', tenantId, asOf: ACTUAL.slice(0, 10) },
              },
            ],
          },
    authorize: async () => true,
    fields: async () => new Set(['id', 'employeeId', 'kind', 'effectiveDate', 'status', 'revision', 'activation']),
  });
  const api = tenantApi(w.db, { authorize, clock: () => new Date(ACTUAL) });
  return (business: { id: string; revision: number }, idempotencyKey?: string) =>
    api.request('POST', `/api/tenant/employment/businesses/${business.id}/activation/retry`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: business.revision,
      body: {},
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
}

/** 甲 A→B 直接调动计划 10-05；B 于 10-09 改名联动；10-10 首次执行因编制预检失败。 */
async function failedLateTransfer(label: string) {
  const w = await activationWorld(testDb().db, label);
  const { employee, hire } = await w.hired();
  const transfer = await w.session.business(
    employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
    hire.employeeRevision,
  );
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const renamed = await api.request('PATCH', `/api/tenant/org/organizations/${w.to.id}`, {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
    ifMatch: w.to.revision,
    body: { name: 'B 改名', effectiveDate: '2026-10-09', addEmployment: true },
  });
  expect(renamed.status, await renamed.clone().text()).toBe(200);
  const adjustment = (await w.session.records(employee.id, '2026-10-09')).find((r) => r.kind === 'org_adjustment')!;
  expect(adjustment.fields.departmentId).toBe(w.to.id);
  fullDepartments.add(w.to.id);
  expect((await w.runScheduler(ACTUAL)).failed).toEqual([transfer.id]);
  fullDepartments.delete(w.to.id);
  return { w, employee, adjustment, failed: await w.business(transfer.id) };
}

async function snapshot(w: ActivationWorld, employeeId: string) {
  return {
    records: await w.session.records(employeeId, '2026-10-10'),
    versions: await versions(w.db, w.session.tenant.id, employeeId),
  };
}

it('AC-ORG-32 R6-P2-04 受限范围 HR 首次重试：重建历史记录按可见口径放行，返回 200', async () => {
  const { w, employee, adjustment, failed } = await failedLateTransfer('org32replay-retry');
  w.session.setNow(ACTUAL);
  const before = await snapshot(w, employee.id);
  expect(before.records.find((r) => r.id === adjustment.id)?.fields.departmentId).toBe(w.to.id);
  const response = await scopedApi(w, [w.to.id])(failed);
  if (response.status !== 200) expect(await snapshot(w, employee.id), '拒绝时整单回滚').toEqual(before);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ id: failed.id, status: 'effective' });
  expect(await w.business(failed.id)).toMatchObject({ activation: { status: 'effective' } });
  const after = await snapshot(w, employee.id);
  expect(after.records.find((r) => r.id === adjustment.id)?.fields.departmentId).toBe(w.from.id);
  expect(after.records.find((r) => r.isCurrent)).toMatchObject({ id: failed.id, effectiveDate: '2026-10-10' });
  expect(after.versions).not.toEqual(before.versions);
});

it('AC-ORG-32 R6-P2-04 成功命令缩小范围后幂等重放：仍返回 200 且既有结果不变', async () => {
  const { w, employee, adjustment, failed } = await failedLateTransfer('org32replay-idem');
  w.session.setNow(ACTUAL);
  const key = randomUUID();
  const first = await scopedApi(w, 'all')(failed, key);
  expect(first.status, await first.clone().text()).toBe(200);
  const body = await first.json();
  expect(await w.business(failed.id)).toMatchObject({ activation: { status: 'effective' } });
  const settled = await snapshot(w, employee.id);
  expect(settled.records.find((r) => r.id === adjustment.id)?.fields.departmentId).toBe(w.from.id);
  const replay = await scopedApi(w, [w.to.id])(failed, key);
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await replay.json()).toEqual(body);
  expect(await snapshot(w, employee.id)).toEqual(settled);
});

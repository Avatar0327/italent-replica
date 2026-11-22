import { eq, onboardingEntryCases, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { entryInfoCollectionAdapter } from '../../apps/api/src/modules/onboarding/approval-contract.js';
import { startCollection } from '../../apps/api/src/modules/onboarding/collection-tasks.js';
import { addPending, entryWorld, portContext } from './AC-EN-BE2a-support.js';
import { tenantApi } from './support/tenant-api.js';

const useDb = useTestDb();
const profile = 'TenantBase.EmployeeInformation';

async function collectionWorld() {
  const { db } = useDb();
  const w = await entryWorld(db, 'ZZ_BE16_LANDING');
  const { employee, recordId, business } = await addPending(w, '2026-10-08', 'ZZ_BE16_CANDIDATE');
  const ctx = portContext(w, 0);
  const api = tenantApi(db);
  const configure = async (path: string, body: object) => {
    const response = await api.request('POST', '/api/tenant/onboarding/' + path, {
      tenant: ctx.tenantId,
      user: ctx.userId,
      ifMatch: 0,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return response.json();
  };
  const template = await configure('collection-templates', {
    name: 'ZZ_BE16_TEMPLATE',
    noticeTitle: 'ZZ_BE16_TITLE',
    noticeBody: 'ZZ_BE16_NOTICE',
    fields: [{ objectCode: profile, fieldCode: 'name', required: true }],
  });
  await configure('collection-rules', {
    name: 'ZZ_BE16_RULE',
    priority: 10,
    templateId: template.id,
    orgIds: [w.org.id],
  });
  const tenant = <T>(run: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx.tenantId, run);
  const ref = await tenant(async (tx) => {
    const [stage] = await tx
      .select()
      .from(onboardingEntryCases)
      .where(eq(onboardingEntryCases.currentBusinessId, recordId));
    return {
      employeeId: employee.id,
      caseId: stage!.id,
      businessId: recordId,
      businessRevision: business.revision,
      caseRevision: stage!.revision,
    };
  });
  const started = await tenant((tx) => startCollection(tx, ctx, ref, 'manual'));
  if (started.status !== 'created') throw new Error('ZZ_BE16_TASK_NOT_CREATED');
  return { w, ctx, employee, tenant, ref, task: started.task };
}

it('AC-EN-BE16-05 已发起采集任务可进入审批前置锁，任意未知任务仍须拒绝', async () => {
  const { task, ctx, tenant } = await collectionWorld();
  await expect(tenant((tx) => entryInfoCollectionAdapter.lock(tx, ctx, task.id))).resolves.toBeUndefined();
  await expect(tenant((tx) => entryInfoCollectionAdapter.lock(tx, ctx, task.caseId))).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

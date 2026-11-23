import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { seedPermissionWorld } from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const now = new Date('2026-11-21T08:00:00Z');
const poolPath = '/api/tenant/onboarding/integration/task-pool';
const actionField = 'integrationTaskPool.action';
const probation = { type: 'assessment', assessmentType: 'probation', name: 'ZZ_BE16_试用中考核' };
const regularization = { type: 'assessment', assessmentType: 'regularization', name: 'ZZ_BE16_转正考核' };
const form = {
  type: 'form',
  fields: [{ code: 'summary', label: 'ZZ_BE16_办理说明', kind: 'text', required: true }],
};

async function fixture() {
  const { db } = database();
  const world = await seedPermissionWorld(db);
  const { asAdmin } = world;
  const auditor = await memberWithAdminRole(world, 'audit_admin', 'ZZ_BE16_POOL_AUDIT_ONLY');
  const audit = auditApi(db, () => now, { authorize: undefined });
  const api = tenantApi(db, { authorize: undefined, clock: () => now });

  async function createTask(code: string, category: string, action: typeof probation | typeof form) {
    const body = { code, category, action, name: 'ZZ_BE16_融入任务' };
    const response = await api.request('POST', poolPath, { ...asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    const { id } = (await response.json()) as { id: string };
    return { ...body, id, description: null, enabled: true, revision: 1 };
  }

  const task = await createTask('ZZ_BE16_AUDIT_ASSESSMENT', 'probation_assessment', probation);
  const patch = await api.request('PATCH', `${poolPath}/${task.id}`, {
    ...asAdmin,
    ifMatch: task.revision,
    body: { action: regularization },
  });
  expect(patch.status, await patch.clone().text()).toBe(200);

  const formTask = await createTask('ZZ_BE16_AUDIT_FORM', 'administrative', form);
  const deleted = await api.request('DELETE', `${poolPath}/${formTask.id}`, { ...asAdmin, ifMatch: formTask.revision });
  expect(deleted.status, await deleted.clone().text()).toBe(204);

  const updateQuery = { objectId: task.id, operation: 'update' };
  const { items: updates } = await audit.dataChanges(asAdmin, updateQuery);
  const { items: deletes } = await audit.dataChanges(asAdmin, { objectId: formTask.id, operation: 'delete' });
  expect(updates).toHaveLength(1);
  expect(deletes).toHaveLength(1);
  return { audit, asAdmin, auditor, task, formTask, updateQuery, updated: updates[0]!, deleted: deletes[0]! };
}

describe('AC-ON-BE16-01 任务池审计字段权限', () => {
  let world: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    world = await fixture();
  });

  it('租户管理员可查看考核动作的差异、正文和前后值', async () => {
    const { audit, asAdmin, updateQuery, updated } = world;
    const detail = await audit.dataChange(asAdmin, updated.id);
    expect(detail.changes, '有权审计详情应返回完整考核动作差异').toMatchObject([
      { field: actionField, from: probation, to: regularization },
    ]);
    expect(detail.content).toContain(probation.name);
    expect(detail.content).toContain(regularization.name);
    expect(detail.before).toMatchObject({ integrationTaskPool: { action: probation } });
    expect(detail.after).toMatchObject({ integrationTaskPool: { action: regularization } });
    expect(updated.changes).toEqual(detail.changes);
    expect(updated.content).toBe(detail.content);
    const filtered = await audit.dataChanges(asAdmin, { ...updateQuery, field: actionField });
    expect(filtered.items.map(({ id }) => id)).toEqual([updated.id]);
  });

  it('租户管理员可从删除前值与快照读取完整办理表单', async () => {
    const { audit, asAdmin, formTask, deleted } = world;
    const detail = await audit.dataChange(asAdmin, deleted.id);
    expect(detail.snapshot, '有权删除快照应返回完整办理表单').toEqual({ integrationTaskPool: formTask });
    expect(detail.before).toEqual(detail.snapshot);
    expect(detail.after).toBeNull();
    expect(detail.changes).toContainEqual(expect.objectContaining({ field: actionField, from: form, to: null }));
    expect(detail.content).toContain(form.fields[0]!.label);
  });

  it('无任务池设置字段权的审计管理员只能看到日志元数据', async () => {
    const { audit, auditor, updated, deleted, updateQuery } = world;
    for (const { id, operation } of [updated, deleted]) {
      const detail = await audit.dataChange(auditor.as, id);
      expect(detail).toMatchObject({
        id,
        operation,
        changes: [],
        content: '',
        before: {},
        after: operation === 'delete' ? null : {},
      });
      expect(detail.snapshot).toEqual(operation === 'delete' ? {} : null);
    }
    const { items } = await audit.dataChanges(auditor.as, updateQuery);
    expect(items).toMatchObject([{ id: updated.id, changes: [], content: '' }]);
    for (const field of [actionField, 'action']) {
      expect((await audit.dataChanges(auditor.as, { ...updateQuery, field })).items).toEqual([]);
    }
  });
});

/**
 * R3-T01 写入口接入审计（DEC-019 / DEC-216；`20` §5）：指标库、指标、标准分类、人才标准的新增 / 修改 / 删除
 * 都与业务同事务写数据变更日志；删除保留完整快照（含指标的等级 / 行为 / 建议 / 问题与标准的指标引用）。
 * 审计查询按查看人当前的人才标准对象权限、数据范围与字段权限裁剪（audit/visibility.ts 登记的查看规则）。
 */
import { randomUUID } from 'node:crypto';
import { TALENT_APP, TALENT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { createProfile, grant, makeGrantable, seedPermissionWorld, setObjectPermission } from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { tenantApi } from './support/tenant-api.js';
import { TC_BASE, TC_NOW, type DimensionView, talentWorld } from './AC-TC-support.js';

const testDb = useTestDb();
const NOW = TC_NOW.toISOString();

describe('R3-T01 审计', () => {
  it('四类对象的新增、修改、删除都写数据变更日志；删除带完整快照', async () => {
    const w = await talentWorld(testDb().db, 'tcaudit');
    const audit = auditApi(testDb().db, NOW);
    const library = await w.library('ability');
    const dimension = await w.dimension(library.id, {
      grades: [{ gradeOrder: 1, alias: '初级', description: '快照等级' }],
      questions: [{ question: '快照问题' }],
    });
    const category = await w.category();
    const criterion = await w.criterion(category.id, [{ dimensionId: dimension.id, weight: 20 }]);
    const patched = await w.request('PATCH', `/dimensions/${dimension.id}`, {
      ifMatch: dimension.revision,
      body: { definition: '新定义' },
    });
    expect(patched.status).toBe(200);
    const updated = (await patched.json()) as DimensionView;
    expect((await w.request('DELETE', `/criteria/${criterion.id}`, { ifMatch: criterion.revision })).status).toBe(200);
    expect((await w.request('DELETE', `/dimensions/${dimension.id}`, { ifMatch: updated.revision })).status).toBe(200);

    const expectLogs = async (objectType: string, operations: string[]) => {
      const { items } = await audit.dataChanges(w.as, { objectType, limit: '50' });
      expect(items.map((item) => item.operation).sort(), objectType).toEqual([...operations].sort());
      for (const item of items) expect(item.app).toBe('人才标准');
      return items;
    };
    await expectLogs(TALENT_OBJECTS.library.code, ['create']);
    await expectLogs(TALENT_OBJECTS.criterionCategory.code, ['create']);
    const criterionLogs = await expectLogs(TALENT_OBJECTS.criterion.code, ['create', 'delete']);
    const dimensionLogs = await expectLogs(TALENT_OBJECTS.dimension.code, ['create', 'update', 'delete']);

    const update = dimensionLogs.find((item) => item.operation === 'update')!;
    expect(update.changes).toEqual([expect.objectContaining({ field: 'definition', to: '新定义' })]);
    const removed = await audit.dataChange(w.as, dimensionLogs.find((item) => item.operation === 'delete')!.id);
    expect(removed.snapshot).toMatchObject({
      id: dimension.id,
      definition: '新定义',
      grades: [{ gradeOrder: 1, alias: '初级', description: '快照等级' }],
      questions: [{ question: '快照问题' }],
    });
    const criterionRemoved = await audit.dataChange(
      w.as,
      criterionLogs.find((item) => item.operation === 'delete')!.id,
    );
    expect(criterionRemoved.snapshot).toMatchObject({
      id: criterion.id,
      dimensions: [{ dimensionId: dimension.id, weight: 20 }],
    });
  });

  it('被拒绝的写入不留数据变更日志（业务与审计同事务）', async () => {
    const w = await talentWorld(testDb().db, 'tcauditfail');
    const audit = auditApi(testDb().db, NOW);
    const library = await w.library('potential');
    const dimension = await w.dimension(library.id);
    const category = await w.category();
    const denied = await w.request('POST', '/criteria', {
      ifMatch: 0,
      body: { categoryId: category.id, name: '违规标准', dimensions: [{ dimensionId: dimension.id, weight: 5 }] },
    });
    expect(denied.status).toBe(400);
    const { items } = await audit.dataChanges(w.as, { objectType: TALENT_OBJECTS.criterion.code, limit: '50' });
    expect(items).toEqual([]);
  });

  it('审计查询按人才标准对象权限、看全部与字段权限裁剪', async () => {
    const db = testDb().db;
    const world = await seedPermissionWorld(db);
    const setup = tenantApi(db, { clock: () => TC_NOW });
    const create = async <T>(path: string, body: unknown, method = 'POST', ifMatch = 0): Promise<T> => {
      const response = await setup.request(method, `${TC_BASE}${path}`, { ...world.asAdmin, ifMatch, body });
      expect(response.status, await response.clone().text()).toBeLessThan(300);
      return (await response.json()) as T;
    };
    const library = await create<{ id: string }>('/libraries', { name: '审计库', type: 'ability' });
    const dimension = await create<DimensionView>('/dimensions', {
      libraryId: library.id,
      code: `A${randomUUID().slice(0, 6)}`,
      name: '审计指标',
      definition: '隐藏定义甲',
    });
    await create<DimensionView>(
      `/dimensions/${dimension.id}`,
      { definition: '隐藏定义乙' },
      'PATCH',
      dimension.revision,
    );
    const audit = auditApi(db, NOW, { authorize: undefined });

    const viewer = await memberWithAdminRole(world, 'audit_admin', 'tc-audit-viewer');
    const query = { objectType: TALENT_OBJECTS.dimension.code, limit: '50' };
    expect((await audit.dataChanges(viewer.as, query)).items).toEqual([]);

    const profile = await createProfile(world, `tc-audit-${randomUUID().slice(0, 6)}`, { apps: [TALENT_APP] });
    const definition = TALENT_OBJECTS.dimension;
    const permission = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: field.code !== 'definition',
          edit: false,
        })),
        buttons: [],
      },
      definition.code,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, viewer.user.id, profile.id)).status).toBe(201);
    // 有对象权限但数据范围默认空：仍看不到
    expect((await audit.dataChanges(viewer.as, query)).items).toEqual([]);

    const scope = await world.api.request(
      'PUT',
      `/api/tenant/permission/profiles/${profile.id}/data-scopes/${TALENT_APP}`,
      {
        ...world.asAdmin,
        ifMatch: 0,
        body: { targetKind: 'app', targetCode: '', seeAll: true },
      },
    );
    expect(scope.status, await scope.clone().text()).toBe(200);
    const { items } = await audit.dataChanges(viewer.as, query);
    // 只改了隐藏字段的修改日志不返回；新增日志返回但不含隐藏字段
    expect(items.map((item) => item.operation)).toEqual(['create']);
    const detail = await audit.dataChange(viewer.as, items[0]!.id);
    expect(detail.after).toMatchObject({ name: '审计指标' });
    expect(JSON.stringify(detail)).not.toContain('隐藏定义');
  });
});

/**
 * R3-T01 写入口接入审计（DEC-019 / DEC-216；`20` §5；DEC-281）：指标库、指标库分类、发展建议类型、指标、标准分类、
 * 人才标准的新增 / 修改 / 删除都与业务同事务写数据变更日志；删除保留完整快照（含指标的等级 / 行为 / 发展建议 / 面试问题
 * 与标准的指标引用）。发展建议子表的增删改记在指标的修改日志里（字段 suggestions）。
 * 审计查询按查看人当前的人才标准对象权限、管理单元范围与字段权限裁剪（audit/visibility.ts 登记的查看规则）。
 */
import { randomUUID } from 'node:crypto';
import { TALENT_APP, TALENT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import {
  BASE,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { tenantApi } from './support/tenant-api.js';
import { clock, seedTalentData } from './AC-TC-permission-support.js';
import { TC_NOW, type DimensionView, talentWorld } from './AC-TC-support.js';

const testDb = useTestDb();
const NOW = TC_NOW.toISOString();

describe('R3-T01 审计', () => {
  it('六类对象 × 新增 / 修改 / 删除 18 格都写数据变更日志，修改日志只含改动字段，删除带快照', async () => {
    const w = await talentWorld(testDb().db, 'tcaudit18');
    const audit = auditApi(testDb().db, NOW);
    const library = await w.library('potential');
    const dimensionCategory = await w.dimensionCategory(library.id);
    const type = await w.descriptionType('审计类型');
    const dimension = await w.dimension(library.id);
    const category = await w.category();
    const criterion = await w.criterion(category.id, [{ dimensionId: dimension.id }]);
    const cells = [
      ['libraries', TALENT_OBJECTS.library.code, library, { name: '改名的库' }, 'name'],
      [
        'dimension-categories',
        TALENT_OBJECTS.dimensionCategory.code,
        dimensionCategory,
        { displayOrder: 9 },
        'displayOrder',
      ],
      ['description-types', TALENT_OBJECTS.descriptionType.code, type, { name: '改名的类型' }, 'name'],
      ['dimensions', TALENT_OBJECTS.dimension.code, dimension, { definition: '新定义' }, 'definition'],
      ['criterion-categories', TALENT_OBJECTS.criterionCategory.code, category, { name: '改名的分类' }, 'name'],
      ['criteria', TALENT_OBJECTS.criterion.code, criterion, { name: '改名的标准' }, 'name'],
    ] as const;
    expect(cells).toHaveLength(Object.keys(TALENT_OBJECTS).length);
    const revisions = new Map<string, number>();
    for (const [path, , item, patch] of cells) {
      const response = await w.request('PATCH', `/${path}/${item.id}`, { ifMatch: item.revision, body: patch });
      expect(response.status, path).toBe(200);
      revisions.set(path, ((await response.json()) as { revision: number }).revision);
    }
    // 删除顺序：先解除引用的标准，再指标、分类、库、类型、标准分类（TC-R5）
    for (const path of [
      'criteria',
      'dimensions',
      'dimension-categories',
      'libraries',
      'description-types',
      'criterion-categories',
    ] as const) {
      const [, , item] = cells.find(([candidate]) => candidate === path)!;
      const response = await w.request('DELETE', `/${path}/${item.id}`, { ifMatch: revisions.get(path)! });
      expect(response.status, path).toBe(200);
    }
    for (const [, objectType, item, , field] of cells) {
      const { items } = await audit.dataChanges(w.as, { objectType, limit: '50' });
      expect(items.map((entry) => entry.operation).sort(), objectType).toEqual(['create', 'delete', 'update']);
      expect(new Set(items.map((entry) => entry.objectId))).toEqual(new Set([item.id]));
      for (const entry of items) expect(entry.app).toBe('人才标准');
      const update = items.find((entry) => entry.operation === 'update')!;
      expect(
        update.changes.map((change) => change.field),
        objectType,
      ).toEqual([field]);
      const removed = await audit.dataChange(w.as, items.find((entry) => entry.operation === 'delete')!.id);
      expect(removed.snapshot, objectType).toMatchObject({ id: item.id });
    }
  });

  it('删除快照完整：指标带四类明细，标准带指标引用；发展建议子表的增 / 改 / 删记在指标修改日志里', async () => {
    const w = await talentWorld(testDb().db, 'tcaudit');
    const audit = auditApi(testDb().db, NOW);
    const library = await w.library('ability');
    const type = await w.descriptionType('行动建议');
    const dimension = await w.dimension(library.id, {
      grades: [{ gradeOrder: 1, alias: '初级', description: '快照等级' }],
      questions: [{ question: '快照问题' }],
    });
    const category = await w.category();
    const criterion = await w.criterion(category.id, [{ dimensionId: dimension.id, weight: 20 }]);
    let revision = dimension.revision;
    for (const suggestions of [
      [{ typeId: type.id, description: '新增的建议', displayOrder: 1 }],
      [{ typeId: type.id, description: '改过的建议', displayOrder: 1 }],
      [],
    ]) {
      const response = await w.request('PATCH', `/dimensions/${dimension.id}`, {
        ifMatch: revision,
        body: { suggestions },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      revision = ((await response.json()) as DimensionView).revision;
    }
    expect((await w.request('DELETE', `/criteria/${criterion.id}`, { ifMatch: criterion.revision })).status).toBe(200);
    expect((await w.request('DELETE', `/dimensions/${dimension.id}`, { ifMatch: revision })).status).toBe(200);

    const { items } = await audit.dataChanges(w.as, { objectType: TALENT_OBJECTS.dimension.code, limit: '50' });
    const updates = items.filter((item) => item.operation === 'update');
    expect(updates).toHaveLength(3);
    for (const update of updates) expect(update.changes.map((change) => change.field)).toEqual(['suggestions']);
    const removed = await audit.dataChange(w.as, items.find((item) => item.operation === 'delete')!.id);
    expect(removed.snapshot).toMatchObject({
      id: dimension.id,
      grades: [{ gradeOrder: 1, alias: '初级', description: '快照等级' }],
      questions: [{ question: '快照问题' }],
      suggestions: [],
    });
    const criterionLogs = await audit.dataChanges(w.as, { objectType: TALENT_OBJECTS.criterion.code, limit: '50' });
    const criterionRemoved = await audit.dataChange(
      w.as,
      criterionLogs.items.find((item) => item.operation === 'delete')!.id,
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
      body: {
        categoryId: category.id,
        name: '违规标准',
        ownerOrgId: w.orgId,
        dimensions: [{ dimensionId: dimension.id, weight: 5 }],
      },
    });
    expect(denied.status).toBe(400);
    const { items } = await audit.dataChanges(w.as, { objectType: TALENT_OBJECTS.criterion.code, limit: '50' });
    expect(items).toEqual([]);
  });

  it('审计查询按人才标准对象权限、管理单元与字段权限裁剪', async () => {
    const db = testDb().db;
    let world = await seedPermissionWorld(db);
    world = { ...world, api: tenantApi(db, { authorize: undefined, clock }) };
    const data = await seedTalentData(world);
    const setup = tenantApi(db, { clock });
    for (const set of [data.inside, data.outside]) {
      const patched = await setup.request('PATCH', `/api/tenant/talent/dimensions/${set.dimension.id}`, {
        ...world.asAdmin,
        ifMatch: set.dimension.revision,
        body: { definition: '隐藏定义乙' },
      });
      expect(patched.status, await patched.clone().text()).toBe(200);
    }
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

    const scope = await world.api.request('PUT', `${BASE}/scopes/${viewer.user.id}/${TALENT_APP}`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'mou', mouId: data.mouId },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);
    const { items } = await audit.dataChanges(viewer.as, query);
    // 只返回管理单元内的指标；只改了隐藏字段的修改日志不返回；新增日志返回但不含隐藏字段
    expect(items.map((item) => [item.objectId, item.operation])).toEqual([[data.inside.dimension.id, 'create']]);
    const detail = await audit.dataChange(viewer.as, items[0]!.id);
    expect(detail.after).toMatchObject({ name: '内战略思维' });
    expect(JSON.stringify(detail)).not.toContain('保密定义');
    expect(JSON.stringify(detail)).not.toContain('隐藏定义');
  });
});

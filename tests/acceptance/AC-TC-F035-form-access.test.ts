/**
 * F-035：表单按服务端可见且可编辑字段渲染；PATCH 仅提交获准字段，不用旧对象补齐裁剪值。
 * 使用真实授权器覆盖全部人才标准对象，以及撤权、范围和幂等重放（DEC-285②、DEC-294、DEC-316）。
 */
import { randomUUID } from 'node:crypto';
import { TALENT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedPermissionWorld, setObjectPermission, type PermissionWorld } from './AC-PRM-support.js';
import { clock, seedTalentData, talentOperator, type TalentPermissionData } from './AC-TC-permission-support.js';
import { TC_BASE } from './AC-TC-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

interface FormAccess {
  readonly editableFields: string[];
  readonly requiredFields: string[];
  readonly blockedReason?: string;
}

const definitions = [
  {
    object: 'library',
    path: 'libraries',
    create: ['name', 'type', 'enabled', 'displayOrder'],
    update: ['name', 'enabled', 'displayOrder'],
    required: ['name', 'type'],
  },
  {
    object: 'dimensionCategory',
    path: 'dimension-categories',
    create: ['libraryId', 'name', 'displayOrder'],
    update: ['name', 'displayOrder'],
    required: ['libraryId', 'name', 'displayOrder'],
  },
  {
    object: 'descriptionType',
    path: 'description-types',
    create: ['name', 'enabled', 'displayOrder'],
    update: ['name', 'enabled', 'displayOrder'],
    required: ['name'],
  },
  {
    object: 'dimension',
    path: 'dimensions',
    create: [
      'libraryId',
      'code',
      'name',
      'definition',
      'categoryId',
      'displayOrder',
      'enabled',
      'grades',
      'behaviors',
      'suggestions',
      'questions',
    ],
    update: [
      'name',
      'definition',
      'categoryId',
      'displayOrder',
      'enabled',
      'grades',
      'behaviors',
      'suggestions',
      'questions',
    ],
    required: ['libraryId', 'code', 'name'],
  },
  {
    object: 'criterionCategory',
    path: 'criterion-categories',
    create: ['name', 'displayOrder'],
    update: ['name', 'displayOrder'],
    required: ['name'],
  },
  {
    object: 'criterion',
    path: 'criteria',
    create: [
      'categoryId',
      'name',
      'enabled',
      'abilityNote',
      'potentialNote',
      'experienceNote',
      'achievementNote',
      'dimensions',
    ],
    update: [
      'categoryId',
      'name',
      'enabled',
      'abilityNote',
      'potentialNote',
      'experienceNote',
      'achievementNote',
      'dimensions',
    ],
    required: ['categoryId', 'name'],
  },
] as const;

const testDb = useTestDb();

describe('F-035 人才标准表单权限契约与部分字段保存', () => {
  let world: PermissionWorld;
  let data: TalentPermissionData;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    data = await seedTalentData(world);
  });

  const targets = () => ({
    library: data.inside.library,
    dimensionCategory: data.inside.dimensionCategory,
    descriptionType: data.type,
    dimension: data.inside.dimension,
    criterionCategory: data.inside.criterionCategory,
    criterion: data.inside.criterion,
  });

  const adminRead = async (path: string): Promise<Record<string, unknown> & { revision: number }> => {
    const response = await data.setup.request('GET', `${TC_BASE}${path}`, world.asAdmin);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Record<string, unknown> & { revision: number };
  };

  it('六个对象返回当前操作的 schema 字段、必填字段，系统字段和管理单元选择不作为可编辑字段', async () => {
    const op = await talentOperator(world, { seeAll: true, mouId: data.mouId });
    for (const definition of definitions) {
      for (const operation of ['create', 'update'] as const) {
        const id = operation === 'update' ? `&id=${targets()[definition.object].id}` : '';
        const response = await op.request('GET', `/forms/${definition.object}?operation=${operation}${id}`);
        expect(response.status, `${definition.object}.${operation}: ${await response.clone().text()}`).toBe(200);
        const access = (await response.json()) as FormAccess;
        expect(access.editableFields.toSorted()).toEqual([...definition[operation]].sort());
        expect(access.requiredFields.toSorted()).toEqual(operation === 'create' ? [...definition.required].sort() : []);
        expect(access).not.toHaveProperty('blockedReason');
      }
    }
  });

  it('六个对象缺少名称查看权时，编辑其余字段成功，隐藏名称和未提交明细保持原值', async () => {
    const hidden = Object.fromEntries(definitions.map(({ object }) => [object, ['name']]));
    const op = await talentOperator(world, { seeAll: true, hidden });
    for (const { object, path } of definitions) {
      const item = targets()[object];
      const target = `/${path}/${item.id}`;
      const before = await adminRead(target);
      const contract = await op.request('GET', `/forms/${object}?operation=update&id=${item.id}`);
      expect(contract.status, await contract.clone().text()).toBe(200);
      const access = (await contract.json()) as FormAccess;
      expect(access.editableFields).not.toContain('name');
      expect(access.editableFields).toContain('displayOrder' in before ? 'displayOrder' : 'abilityNote');
      const body =
        'displayOrder' in before ? { displayOrder: Number(before.displayOrder) + 3 } : { abilityNote: '新说明' };
      const response = await op.request('PATCH', target, { ifMatch: before.revision, body });
      expect(response.status, `${object}: ${await response.clone().text()}`).toBe(200);
      expect((await response.json()) as object).not.toHaveProperty('name');
      expect(await adminRead(target)).toEqual({ ...before, ...body, revision: before.revision + 1 });
    }
  });

  it('可见但只读的字段不出现在可编辑集合，提交该字段仍整单 403，其余字段可保存', async () => {
    const op = await talentOperator(world, { seeAll: true, readonly: { dimension: ['definition', 'grades'] } });
    const target = `/dimensions/${data.inside.dimension.id}`;
    const before = await adminRead(target);
    const contract = await op.request('GET', `/forms/dimension?operation=update&id=${data.inside.dimension.id}`);
    expect(contract.status, await contract.clone().text()).toBe(200);
    const access = (await contract.json()) as FormAccess;
    expect(access.editableFields).not.toContain('definition');
    expect(access.editableFields).not.toContain('grades');
    for (const body of [{ definition: null }, { grades: [] }, { definition: '越权值', displayOrder: 23 }]) {
      const response = await op.request('PATCH', target, { ifMatch: before.revision, body });
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('FORBIDDEN');
    }
    expect(await adminRead(target)).toEqual(before);
    const allowed = await op.request('PATCH', target, { ifMatch: before.revision, body: { enabled: false } });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    expect(await adminRead(target)).toEqual({ ...before, enabled: false, revision: before.revision + 1 });
  });

  it('新建必填字段被裁剪时返回明确禁用原因，不构造默认值；隐藏可选字段不妨碍创建', async () => {
    const op = await talentOperator(world, {
      seeAll: true,
      mouId: data.mouId,
      hidden: { library: ['name'], dimension: ['definition'] },
    });
    const blocked = await op.request('GET', '/forms/library?operation=create');
    expect(blocked.status, await blocked.clone().text()).toBe(200);
    const access = (await blocked.json()) as FormAccess;
    expect(access.editableFields).not.toContain('name');
    expect(access.requiredFields).toContain('name');
    expect(access.blockedReason).toEqual(expect.any(String));
    expect(access.blockedReason).toBeTruthy();

    const available = await op.request('GET', '/forms/dimension?operation=create');
    expect(available.status).toBe(200);
    const dimensionAccess = (await available.json()) as FormAccess;
    expect(dimensionAccess.editableFields).not.toContain('definition');
    expect(dimensionAccess).not.toHaveProperty('blockedReason');
    const created = await op.request('POST', '/dimensions', {
      ifMatch: 0,
      body: { libraryId: data.inside.library.id, code: `F035${randomUUID().slice(0, 6)}`, name: '字段裁剪新指标' },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    expect((await created.json()) as object).not.toHaveProperty('definition');
  });

  it('对象操作权或按钮被撤销时契约拒绝；拿到契约后撤销字段权，原命令重放也 403', async () => {
    const op = await talentOperator(world, { seeAll: true, objects: ['library'] });
    const target = `/libraries/${data.inside.library.id}`;
    const before = await adminRead(target);
    const command = {
      ifMatch: before.revision,
      idempotencyKey: `f035-replay-${randomUUID()}`,
      body: { displayOrder: 31 },
    };
    const first = await op.request('PATCH', target, command);
    expect(first.status, await first.clone().text()).toBe(200);
    const definition = TALENT_OBJECTS.library;
    const revoked = await setObjectPermission(
      world,
      op.profile,
      {
        dataOperations: { create: true, update: true, delete: true },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: true,
          edit: !field.system && field.code !== 'displayOrder',
        })),
        buttons: definition.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
      },
      definition.code,
    );
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    const contract = await op.request('GET', `/forms/library?operation=update&id=${data.inside.library.id}`);
    expect(contract.status).toBe(200);
    expect(((await contract.json()) as FormAccess).editableFields).not.toContain('displayOrder');
    const replay = await op.request('PATCH', target, command);
    expect(replay.status).toBe(403);
    expect(await errorCode(replay)).toBe('FORBIDDEN');
    expect((await adminRead(target)).revision).toBe(before.revision + 1);

    await op.setButtons(false);
    const noButton = await op.request('GET', `/forms/library?operation=update&id=${data.inside.library.id}`);
    expect(noButton.status).toBe(403);
    expect(await errorCode(noButton)).toBe('FORBIDDEN');
    const noObject = await op.request('GET', '/forms/dimension?operation=create');
    expect(noObject.status).toBe(403);
    expect(await errorCode(noObject)).toBe('FORBIDDEN');
  });

  it('编辑契约先验范围，范围外与不存在同一 404；空范围也不提供对象契约', async () => {
    const op = await talentOperator(world, { mouId: data.mouId });
    const outside = await op.request('GET', `/forms/dimension?operation=update&id=${data.outside.dimension.id}`);
    const absent = await op.request('GET', `/forms/dimension?operation=update&id=${randomUUID()}`);
    expect(outside.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await outside.json()).toEqual(await absent.json());
    await op.setMou(null);
    const noScope = await op.request('GET', `/forms/dimension?operation=update&id=${data.inside.dimension.id}`);
    expect(noScope.status).toBe(404);
    expect(await errorCode(noScope)).toBe('NOT_FOUND');
  });

  it('非法对象、操作及标识明确 400，update 缺少 id 不降级成新建', async () => {
    const op = await talentOperator(world, { seeAll: true });
    for (const path of [
      '/forms/not-an-object?operation=create',
      '/forms/library?operation=delete',
      '/forms/library',
      '/forms/library?operation=update',
      '/forms/library?operation=update&id=invalid',
    ]) {
      const response = await op.request('GET', path);
      expect(response.status, path).toBe(400);
      expect(await errorCode(response)).toBe('VALIDATION_FAILED');
    }
  });
});

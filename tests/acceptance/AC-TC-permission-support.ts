/**
 * R3-T01 权限用例夹具（真实授权器）：两个组织（管理单元内 / 外）各一套人才标准数据，一个只含“内”组织的管理单元，
 * 以及按需配置对象权限、按钮、看全部与管理单元范围的操作人（DEC-043：范围按 用户 × TalentCenter 存一份）。
 */
import { randomUUID } from 'node:crypto';
import { TALENT_APP, TALENT_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  type ProfileBody,
  setObjectPermission,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import {
  createOrg,
  type CriterionView,
  type DescriptionTypeView,
  type DimensionCategoryView,
  type DimensionView,
  type LibraryView,
  TC_BASE,
  TC_NOW,
} from './AC-TC-support.js';

export type ObjectKey = keyof typeof TALENT_OBJECTS;
export const clock = () => TC_NOW;

/** 一套挂在某个组织下的人才标准数据。 */
export interface OwnedSet {
  readonly orgId: string;
  readonly library: LibraryView;
  readonly dimensionCategory: DimensionCategoryView;
  readonly dimension: DimensionView;
  readonly criterionCategory: { id: string; revision: number };
  readonly criterion: CriterionView;
}

export interface TalentPermissionData {
  readonly setup: ReturnType<typeof tenantApi>;
  readonly type: DescriptionTypeView;
  readonly inside: OwnedSet;
  readonly outside: OwnedSet;
  readonly mouId: string;
}

/** 建数据用“全部允许”的授权钩子，操作人是租户管理员（创建人、所属人）。 */
export async function seedTalentData(world: PermissionWorld): Promise<TalentPermissionData> {
  const setup = tenantApi(world.db, { clock });
  const create = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await setup.request('POST', `${TC_BASE}${path}`, { ...world.asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  };
  const type = await create<DescriptionTypeView>('/description-types', { name: '行动建议' });
  const owned = async (orgId: string, label: string): Promise<OwnedSet> => {
    const library = await create<LibraryView>('/libraries', {
      name: `${label}能力库`,
      type: 'ability',
      ownerOrgId: orgId,
    });
    const dimensionCategory = await create<DimensionCategoryView>('/dimension-categories', {
      libraryId: library.id,
      name: `${label}通用`,
      displayOrder: 1,
    });
    const dimension = await create<DimensionView>('/dimensions', {
      libraryId: library.id,
      code: `P${randomUUID().slice(0, 8)}`,
      name: `${label}战略思维`,
      definition: '保密定义',
      categoryId: dimensionCategory.id,
      grades: [{ gradeOrder: 1, alias: '初级', description: '保密等级说明' }],
      suggestions: [{ typeId: type.id, description: '保密建议', displayOrder: 1 }],
    });
    const criterionCategory = await create<{ id: string; revision: number }>('/criterion-categories', {
      name: `${label}管理序列`,
      ownerOrgId: orgId,
    });
    const criterion = await create<CriterionView>('/criteria', {
      categoryId: criterionCategory.id,
      name: `${label}总监标准`,
      abilityNote: '能力说明',
      ownerOrgId: orgId,
      dimensions: [{ dimensionId: dimension.id, weight: 50, target: 3 }],
    });
    return { orgId, library, dimensionCategory, dimension, criterionCategory, criterion };
  };
  const insideOrg = await createOrg(setup, world.asAdmin, '人才标准部（范围内）');
  const outsideOrg = await createOrg(setup, world.asAdmin, '人才标准部（范围外）');
  const mou = await world.api.request('POST', `${BASE}/mous`, {
    ...world.asAdmin,
    ifMatch: 0,
    body: {
      code: `tc-mou-${randomUUID().slice(0, 6)}`,
      name: '人才标准管理单元',
      orgRanges: [{ orgId: insideOrg, includeDescendants: true }],
    },
  });
  expect(mou.status, await mou.clone().text()).toBe(201);
  return {
    setup,
    type,
    inside: await owned(insideOrg, '内'),
    outside: await owned(outsideOrg, '外'),
    mouId: ((await mou.json()) as { id: string }).id,
  };
}

export interface OperatorOptions {
  readonly objects?: readonly ObjectKey[];
  readonly hidden?: Partial<Record<ObjectKey, readonly string[]>>;
  readonly readonly?: Partial<Record<ObjectKey, readonly string[]>>;
  readonly seeAll?: boolean;
  /** 用户 × TalentCenter 的管理单元（DEC-043）。 */
  readonly mouId?: string;
  /** 是否授予对象登记的全部按钮（缺省授予）。 */
  readonly buttons?: boolean;
}

export async function talentOperator(world: PermissionWorld, options: OperatorOptions = {}) {
  const profile: ProfileBody = await createProfile(world, `tc-${randomUUID().slice(0, 8)}`, { apps: [TALENT_APP] });
  const setButtons = async (buttons: boolean) => {
    for (const key of options.objects ?? (Object.keys(TALENT_OBJECTS) as ObjectKey[])) {
      const definition = TALENT_OBJECTS[key];
      const hidden = new Set(options.hidden?.[key] ?? []);
      const locked = new Set(options.readonly?.[key] ?? []);
      const response = await setObjectPermission(
        world,
        profile,
        {
          dataOperations: { create: true, update: true, delete: true },
          fields: definition.fields.map((field) => ({
            fieldCode: field.code,
            view: !hidden.has(field.code),
            edit: !field.system && !hidden.has(field.code) && !locked.has(field.code),
          })),
          buttons: buttons
            ? definition.buttons.map((button) => ({ buttonCode: button.code, level: button.level }))
            : [],
        },
        definition.code,
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
  };
  await setButtons(options.buttons ?? true);
  await makeGrantable(world, [profile.id]);
  const user = await addMember(world, `tc-operator-${randomUUID().slice(0, 4)}`);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const as = { user: user.id, tenant: world.tenant.id };
  let seeAllRevision = 0;
  const setSeeAll = async (seeAll: boolean) => {
    const response = await world.api.request('PUT', `${BASE}/profiles/${profile.id}/data-scopes/${TALENT_APP}`, {
      ...world.asAdmin,
      ifMatch: seeAllRevision,
      body: { targetKind: 'app', targetCode: '', seeAll },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    seeAllRevision = ((await response.json()) as { revision: number }).revision;
  };
  let scopeRevision = 0;
  /** 用户 × TalentCenter 的范围：选管理单元，或回到缺省（人才标准应用缺省为空）。 */
  const setMou = async (mouId: string | null) => {
    const response = await world.api.request('PUT', `${BASE}/scopes/${user.id}/${TALENT_APP}`, {
      ...world.asAdmin,
      ifMatch: scopeRevision,
      body: mouId ? { kind: 'mou', mouId } : { kind: 'default' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    scopeRevision = ((await response.json()) as { revision: number }).revision;
  };
  if (options.seeAll) await setSeeAll(true);
  if (options.mouId) await setMou(options.mouId);
  const request = (method: string, path: string, extra: Parameters<typeof world.api.request>[2] = {}) =>
    world.api.request(method, `${TC_BASE}${path}`, { ...as, ...extra });
  return { profile, user, as, request, setSeeAll, setMou, setButtons };
}

/** 挂所属管理单元的五个对象在 owned 数据里的路径与对象（发展建议类型是字典，另测）。 */
export function ownedTargets(set: OwnedSet) {
  return [
    ['libraries', set.library],
    ['dimension-categories', set.dimensionCategory],
    ['dimensions', set.dimension],
    ['criterion-categories', set.criterionCategory],
    ['criteria', set.criterion],
  ] as const;
}

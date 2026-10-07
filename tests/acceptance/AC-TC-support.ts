/**
 * R3-T01 人才标准与指标库验收夹具（docs/02_业务建模/23 §2、§7；REQ-TC-001；DEC-281）。
 * 接口挂在 /api/tenant/talent/ 之下；缺省注入“全部允许”的授权钩子，权限用例另用真实授权器。
 * 指标库、标准分类、人才标准挂所属管理单元（DEC-281⑨，以组织表达，DEC-026 同思路），夹具先建一个组织作为缺省归属。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { type RequestOptions, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

export const TC_NOW = new Date('2026-10-07T02:00:00.000Z');
export const TC_BASE = '/api/tenant/talent';
export const TC_ORG_PATH = '/api/tenant/org/organizations';
/** 原站提示原文（`23` §7 #5，W-578）。 */
export const DUPLICATE_MESSAGE = '名称或者编码重复，请重新输入';

export type DimensionType = 'ability' | 'potential' | 'experience';

interface Owned {
  readonly id: string;
  readonly revision: number;
  readonly ownerId: string;
  readonly ownerOrgId: string;
}

export interface LibraryView extends Owned {
  readonly name: string;
  readonly type: DimensionType;
  readonly enabled: boolean;
  readonly displayOrder: number;
}

export interface DimensionCategoryView extends Owned {
  readonly libraryId: string;
  readonly name: string;
  readonly displayOrder: number;
}

export interface DescriptionTypeView {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly displayOrder: number;
}

export interface SuggestionView {
  readonly typeId: string;
  readonly typeName: string;
  readonly description: string;
  readonly displayOrder: number;
}

export interface DimensionView extends Owned {
  readonly libraryId: string;
  readonly type: DimensionType;
  readonly code: string;
  readonly name: string;
  readonly definition: string | null;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly displayOrder: number;
  readonly enabled: boolean;
  readonly grades: { gradeOrder: number; alias: string | null; description: string | null }[];
  readonly behaviors: { description: string; keyPoints: string | null; displayOrder: number }[];
  readonly suggestions: SuggestionView[];
  readonly questions: { question: string; keyPoints: string | null; displayOrder: number }[];
}

export interface CriterionDimensionView {
  readonly dimensionId: string;
  readonly type: DimensionType;
  readonly weight: number | null;
  readonly target: number | null;
  readonly displayOrder: number;
  /** DEC-281⑪：只投影 名称、定义、指标类别。 */
  readonly dimension?: { name?: string; definition?: string | null; categoryName?: string | null };
}

export interface CriterionView extends Owned {
  readonly categoryId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly abilityNote: string | null;
  readonly potentialNote: string | null;
  readonly experienceNote: string | null;
  readonly achievementNote: string | null;
  readonly dimensions: CriterionDimensionView[];
}

export interface Identity {
  readonly user: string;
  readonly tenant: string;
}

type Api = ReturnType<typeof tenantApi>;

/** 经组织接口建一个组织（带版本与层级，数据范围解析需要它们）。 */
export async function createOrg(api: Api, who: Identity, name: string, parentId = who.tenant): Promise<string> {
  const response = await api.request('POST', TC_ORG_PATH, {
    ...who,
    ifMatch: 0,
    body: { name, establishedOn: '2026-01-01', parents: { admin: { parentId } } },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** 一个租户 + 一名成员 + 一个组织，带建库 / 分类 / 类型 / 指标 / 标准的快捷方法。 */
export async function talentWorld(db: Db, label: string, deps: Parameters<typeof tenantApi>[1] = {}) {
  const member = await seedTenantWithMember(db, label);
  const api = tenantApi(db, { clock: () => TC_NOW, ...deps });
  const as: Identity = { user: member.user.id, tenant: member.tenant.id };
  const orgId = await createOrg(api, as, `${label}人才标准部`);
  const request = (method: string, path: string, options: RequestOptions = {}, who: Identity = as) =>
    api.request(method, `${TC_BASE}${path}`, { ...options, ...who });

  async function created<T>(path: string, body: unknown, who: Identity = as): Promise<T> {
    const response = await request('POST', path, { ifMatch: 0, body }, who);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  }

  async function read<T>(path: string, who: Identity = as): Promise<T> {
    const response = await request('GET', path, {}, who);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as T;
  }

  const library = (type: DimensionType, extra: Record<string, unknown> = {}) =>
    created<LibraryView>('/libraries', { name: `${type}指标库`, type, ownerOrgId: orgId, ...extra });

  const dimensionCategory = (libraryId: string, extra: Record<string, unknown> = {}) =>
    created<DimensionCategoryView>('/dimension-categories', { libraryId, name: '通用能力', displayOrder: 1, ...extra });

  const descriptionType = (name = '行动建议', extra: Record<string, unknown> = {}) =>
    created<DescriptionTypeView>('/description-types', { name, ...extra });

  const dimension = (libraryId: string, extra: Record<string, unknown> = {}) =>
    created<DimensionView>('/dimensions', {
      libraryId,
      code: `D${randomUUID().slice(0, 8)}`,
      name: `客户导向${randomUUID().slice(0, 4)}`,
      definition: '以客户为中心',
      ...extra,
    });

  const category = (name = '管理序列', extra: Record<string, unknown> = {}) =>
    created<{ id: string; revision: number; ownerOrgId: string }>('/criterion-categories', {
      name,
      ownerOrgId: orgId,
      ...extra,
    });

  const criterion = (categoryId: string, dimensions: unknown[], extra: Record<string, unknown> = {}) =>
    created<CriterionView>('/criteria', {
      categoryId,
      name: '销售经理人才标准',
      ownerOrgId: orgId,
      dimensions,
      ...extra,
    });

  return {
    ...member,
    api,
    as,
    orgId,
    request,
    read,
    created,
    library,
    dimensionCategory,
    descriptionType,
    dimension,
    category,
    criterion,
  };
}

export type TalentWorld = Awaited<ReturnType<typeof talentWorld>>;

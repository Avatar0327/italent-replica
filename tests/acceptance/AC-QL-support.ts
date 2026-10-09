/**
 * R3-T02 任职资格配置的验收夹具（docs/02_业务建模/23 §3；设计 docs/08_设计/R3-T02_任职资格与人才评定_设计.md §3.1）。
 * 接口挂在 /api/tenant/qualification/ 之下；缺省注入“全部允许”的授权钩子，权限用例另用真实授权器。
 * 资源集合（所属管理单元）由系统按创建人在 Qualification 应用里的授权管理单元填写（DEC-324②）：夹具先建一个组织，
 * 并把只含该组织的管理单元授权给成员（用户 × Qualification，DEC-043）。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { createMou, createOrg, type Identity, TC_NOW, TC_PERMISSION_PATH } from './AC-TC-support.js';
import { type RequestOptions, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

export const QL_BASE = '/api/tenant/qualification';
export const QL_APP = 'Qualification';
export const QL_NOW = TC_NOW;

export interface Owned {
  readonly id: string;
  readonly revision: number;
  readonly ownerId: string;
  readonly ownerOrgId: string;
  readonly publicDown: boolean;
}
export interface CategoryView extends Owned {
  readonly code: string;
  readonly name: string;
  readonly classId: string;
  readonly jobLinkType: string | null;
  readonly jobLinks: { jobObjectId: string }[];
  readonly enabled: boolean;
}
export interface LevelView extends Owned {
  readonly code: string;
  readonly name: string;
  readonly displayOrder: number;
}
export interface TargetView extends Owned {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly isCommon: boolean;
  readonly evalMode: 'score' | 'grade';
  readonly gradeSchemeId: string | null;
}
export interface AbilityView {
  readonly id: string;
  readonly content?: string;
  readonly source: 'manual' | 'copied' | 'common_overwrite';
  readonly projectionHidden?: true;
}
export interface DetailView {
  readonly levelId: string;
  readonly targetId: string;
  readonly locked: boolean;
  readonly abilities: AbilityView[];
}
export interface StandardView {
  readonly id: string;
  readonly revision: number;
  readonly categoryId: string;
  readonly ownerOrgId: string;
  readonly levelIds: string[];
  readonly details: DetailView[];
}
export interface GradeSchemeView {
  readonly id: string;
  readonly revision: number;
  readonly details: { id: string; name: string; grade: number; description: string | null }[];
}

type Api = ReturnType<typeof tenantApi>;

/** 用户 × Qualification 的授权管理单元（DEC-043）；null 回到缺省（空）。返回新的 revision。 */
export async function assignQualificationMou(
  api: Api,
  who: Identity,
  userId: string,
  mouId: string | null,
  revision: number,
): Promise<number> {
  const response = await api.request('PUT', `${TC_PERMISSION_PATH}/scopes/${userId}/${QL_APP}`, {
    ...who,
    ifMatch: revision,
    body: mouId ? { kind: 'mou', mouId } : { kind: 'default' },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { revision: number }).revision;
}

const suffix = () => randomUUID().slice(0, 6);

/** 一个租户 + 一名成员 + 一个组织（授权给成员的 Qualification 管理单元只含它），带建各对象的快捷方法。 */
export async function qualificationWorld(db: Db, label: string, deps: Parameters<typeof tenantApi>[1] = {}) {
  const member = await seedTenantWithMember(db, label);
  const api = tenantApi(db, { clock: () => QL_NOW, ...deps });
  const as: Identity = { user: member.user.id, tenant: member.tenant.id };
  const orgId = await createOrg(api, as, `${label}任职资格部`);
  const mouId = await createMou(api, as, [orgId], '任职资格');
  await assignQualificationMou(api, as, as.user, mouId, 0);
  const request = (method: string, path: string, options: RequestOptions = {}, who: Identity = as) =>
    api.request(method, `${QL_BASE}${path}`, { ...options, ...who });

  async function ok<T>(response: Response, status = 200): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  }
  const created = <T>(path: string, body: unknown, who: Identity = as) =>
    request('POST', path, { ifMatch: 0, body }, who).then((r) => ok<T>(r, 201));
  const read = <T>(path: string, who: Identity = as) => request('GET', path, {}, who).then((r) => ok<T>(r));
  const patch = <T>(path: string, revision: number, body: unknown, who: Identity = as) =>
    request('PATCH', path, { ifMatch: revision, body }, who).then((r) => ok<T>(r));

  const categoryClass = (extra: Record<string, unknown> = {}) =>
    created<Owned & { code: string }>('/category-classes', { code: `K${suffix()}`, name: '管理类', ...extra });
  const category = (classId: string, extra: Record<string, unknown> = {}) =>
    created<CategoryView>('/categories', { code: `C${suffix()}`, name: `类别${suffix()}`, classId, ...extra });
  const level = (displayOrder: number, extra: Record<string, unknown> = {}) =>
    created<LevelView>('/levels', { code: `L${suffix()}`, name: `P${displayOrder}`, displayOrder, ...extra });
  const targetType = (extra: Record<string, unknown> = {}) =>
    created<Owned>('/target-types', { code: `T${suffix()}`, name: '专业能力', ...extra });
  const target = (typeId: string, extra: Record<string, unknown> = {}) =>
    created<TargetView>('/targets', {
      code: `Z${suffix()}`,
      name: `指标${suffix()}`,
      typeId,
      description: '指标说明 A',
      evalMode: 'score',
      ...extra,
    });
  const gradeScheme = (details: unknown[], extra: Record<string, unknown> = {}) =>
    created<GradeSchemeView>('/grade-schemes', { name: `方案${suffix()}`, details, ...extra });
  const standard = (body: Record<string, unknown>) =>
    created<StandardView>('/standards', { name: '任职资格标准', ...body });

  /** 组织员工侧的职务序列（引入任职类别用）。 */
  const sequence = async (name: string) => {
    const response = await api.request('POST', '/api/tenant/job/sequences', {
      ...as,
      ifMatch: 0,
      body: { name, code: `S${suffix()}`, startDate: '2020-01-01' },
    });
    return (await ok<{ id: string }>(response, 201)).id;
  };

  return {
    ...member,
    api,
    as,
    orgId,
    mouId,
    request,
    ok,
    created,
    read,
    patch,
    categoryClass,
    category,
    level,
    targetType,
    target,
    gradeScheme,
    standard,
    sequence,
  };
}

export type QualificationWorld = Awaited<ReturnType<typeof qualificationWorld>>;

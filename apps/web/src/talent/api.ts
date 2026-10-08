import { text } from './messages.js';

export type DimensionType = 'ability' | 'potential' | 'experience';
export const DIMENSION_TYPES: readonly DimensionType[] = ['ability', 'potential', 'experience'];

/** DEC-281⑨：所属人与所属管理单元（组织），由系统按创建人填写（DEC-294③）。 */
interface Owned {
  readonly id: string;
  readonly revision: number;
  readonly ownerId?: string;
  readonly ownerOrgId?: string;
}
export interface Library extends Owned {
  readonly name: string;
  readonly type: DimensionType;
  readonly enabled: boolean;
  readonly displayOrder: number;
}
/** 指标库内分类（DEC-281③）。 */
export interface DimensionCategory extends Owned {
  readonly libraryId: string;
  readonly name: string;
  readonly displayOrder: number;
}
/** 发展建议类型（DEC-281④）。 */
export interface DescriptionType {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly displayOrder: number;
}
export interface Grade {
  gradeOrder: number;
  alias?: string | null;
  description?: string | null;
}
export interface Behavior {
  description: string;
  keyPoints?: string | null;
  displayOrder?: number;
}
export interface Suggestion {
  /** 已有建议行的行身份（编辑时带回，DEC-297②）；新增行没有。 */
  id?: string;
  typeId: string;
  typeName?: string;
  description: string;
  displayOrder: number;
}
export interface Question {
  question: string;
  keyPoints?: string | null;
  displayOrder?: number;
}
export interface Dimension extends Owned {
  readonly libraryId: string;
  readonly type: DimensionType;
  readonly code: string;
  readonly name: string;
  readonly definition?: string | null;
  readonly categoryId?: string | null;
  readonly categoryName?: string | null;
  readonly displayOrder: number;
  readonly enabled: boolean;
  readonly grades?: Grade[];
  readonly behaviors?: Behavior[];
  readonly suggestions?: Suggestion[];
  readonly questions?: Question[];
}
export interface Category extends Owned {
  readonly name: string;
  readonly displayOrder: number;
}
export interface CriterionDimension {
  readonly dimensionId: string;
  readonly type: DimensionType;
  readonly weight: number | null;
  readonly target: number | null;
  readonly displayOrder: number;
  /** 关联记录自己的“指标类别”文本（DEC-294⑤）。 */
  readonly dimensionCategory?: string | null;
  /** 指标库当前内容（TC-R2），只有 名称、定义（DEC-281⑪）；无权查看指标时缺省。 */
  readonly dimension?: { name?: string; definition?: string | null };
}
export type NoteKey = 'abilityNote' | 'potentialNote' | 'experienceNote' | 'achievementNote';
export interface Criterion extends Owned, Partial<Record<NoteKey, string | null>> {
  readonly categoryId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly dimensions?: CriterionDimension[];
}
/** 当前用户在人才标准应用里的授权管理单元（DEC-294③）。 */
/** 授权管理单元：查看人看不到组织的编码 / 名称时只有 ID（DEC-309）。 */
export interface OwnerOrg {
  readonly id: string;
  readonly code?: string;
  readonly name?: string;
}
export type OwnerObject = 'library' | 'dimensionCategory' | 'dimension' | 'criterionCategory' | 'criterion';
export interface ListResult<T> {
  readonly items: T[];
  readonly hasDataPermission: boolean;
}

/** 服务端明确拒绝（4xx）：按返回的原因提示，不自动重试。 */
export class TalentApiError extends Error {}

export async function request<T>(tenantId: string, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/tenant/talent/${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId, ...options.headers },
  });
  const result = (await response.json()) as T & { error?: { message: string } };
  if (response.status >= 500) throw new Error(text.uncertain);
  if (!response.ok) throw new TalentApiError(result.error?.message ?? text.failed);
  return result;
}

/** 分页读完整个列表（候选与下拉用；每页 200，服务端上限）。 */
export async function listAll<T>(tenantId: string, path: string): Promise<T[]> {
  const items: T[] = [];
  const join = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= 50; page++) {
    const result = await request<ListResult<T>>(tenantId, `${path}${join}pageSize=200&page=${page}`);
    items.push(...result.items);
    if (result.items.length < 200) break;
  }
  return items;
}

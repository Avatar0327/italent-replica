import { text } from './messages.js';

export type DimensionType = 'ability' | 'potential' | 'experience';
export const DIMENSION_TYPES: readonly DimensionType[] = ['ability', 'potential', 'experience'];

export interface Library {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly type: DimensionType;
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
  suggestionType?: string | null;
  description: string;
  displayOrder?: number;
}
export interface Question {
  question: string;
  keyPoints?: string | null;
  displayOrder?: number;
}
export interface Dimension {
  readonly id: string;
  readonly revision: number;
  readonly libraryId: string;
  readonly libraryName?: string;
  readonly type: DimensionType;
  readonly libraryEnabled: boolean;
  readonly code: string;
  readonly name: string;
  readonly definition?: string | null;
  readonly category?: string | null;
  readonly displayOrder: number;
  readonly enabled: boolean;
  readonly grades?: Grade[];
  readonly behaviors?: Behavior[];
  readonly suggestions?: Suggestion[];
  readonly questions?: Question[];
}
export interface Category {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly displayOrder: number;
}
export interface CriterionDimension {
  readonly dimensionId: string;
  readonly type: DimensionType;
  readonly weight: number | null;
  readonly target: number | null;
  readonly displayOrder: number;
  /** 指标库当前内容（TC-R2）；无权查看指标时缺省。 */
  readonly dimension?: Partial<Dimension>;
}
export type NoteKey = 'abilityNote' | 'potentialNote' | 'experienceNote' | 'achievementNote';
export interface Criterion extends Partial<Record<NoteKey, string | null>> {
  readonly id: string;
  readonly revision: number;
  readonly categoryId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly dimensions?: CriterionDimension[];
}
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

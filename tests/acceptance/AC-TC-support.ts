/**
 * R3-T01 人才标准与指标库验收夹具（docs/02_业务建模/23 §2；REQ-TC-001）。
 * 接口挂在 /api/tenant/talent/ 之下；缺省注入“全部允许”的授权钩子，权限用例另用真实授权器。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { type RequestOptions, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

export const TC_NOW = new Date('2026-10-07T02:00:00.000Z');
export const TC_BASE = '/api/tenant/talent';

export type DimensionType = 'ability' | 'potential' | 'experience';

export interface LibraryView {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly type: DimensionType;
  readonly enabled: boolean;
  readonly displayOrder: number;
  readonly createdBy?: string;
}

export interface DimensionView {
  readonly id: string;
  readonly revision: number;
  readonly libraryId: string;
  readonly type: DimensionType;
  readonly code: string;
  readonly name: string;
  readonly definition: string | null;
  readonly category: string | null;
  readonly displayOrder: number;
  readonly enabled: boolean;
  readonly libraryEnabled: boolean;
  readonly grades: { gradeOrder: number; alias: string | null; description: string | null }[];
  readonly behaviors: { description: string; keyPoints: string | null; displayOrder: number }[];
  readonly suggestions: { suggestionType: string | null; description: string; displayOrder: number }[];
  readonly questions: { question: string; keyPoints: string | null; displayOrder: number }[];
}

export interface CriterionDimensionView {
  readonly dimensionId: string;
  readonly type: DimensionType;
  readonly weight: number | null;
  readonly target: number | null;
  readonly displayOrder: number;
  readonly dimension?: Partial<DimensionView>;
}

export interface CriterionView {
  readonly id: string;
  readonly revision: number;
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

/** 一个租户 + 一名成员，带建库 / 建指标 / 建标准的快捷方法。 */
export async function talentWorld(db: Db, label: string, deps: Parameters<typeof tenantApi>[1] = {}) {
  const member = await seedTenantWithMember(db, label);
  const api = tenantApi(db, { clock: () => TC_NOW, ...deps });
  const as: Identity = { user: member.user.id, tenant: member.tenant.id };
  const request = (method: string, path: string, options: RequestOptions = {}, who: Identity = as) =>
    api.request(method, `${TC_BASE}${path}`, { ...options, ...who });

  async function created<T>(path: string, body: unknown): Promise<T> {
    const response = await request('POST', path, { ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  }

  async function read<T>(path: string, who: Identity = as): Promise<T> {
    const response = await request('GET', path, {}, who);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as T;
  }

  const library = (type: DimensionType, extra: Record<string, unknown> = {}) =>
    created<LibraryView>('/libraries', { name: `${type}指标库`, type, ...extra });

  const dimension = (libraryId: string, extra: Record<string, unknown> = {}) =>
    created<DimensionView>('/dimensions', {
      libraryId,
      code: `D${randomUUID().slice(0, 8)}`,
      name: '客户导向',
      definition: '以客户为中心',
      ...extra,
    });

  const category = (name = '管理序列') => created<{ id: string; revision: number }>('/criterion-categories', { name });

  const criterion = (categoryId: string, dimensions: unknown[], extra: Record<string, unknown> = {}) =>
    created<CriterionView>('/criteria', { categoryId, name: '销售经理人才标准', dimensions, ...extra });

  return { ...member, api, as, request, read, library, dimension, category, criterion };
}

export type TalentWorld = Awaited<ReturnType<typeof talentWorld>>;

/**
 * F-481 调动电子签署验收夹具（S1：模板库、场景设置、模板选项）。
 * 合成数据：模板编码 syn.esign.*、名称 ZZ_F481_*，不含真实个人信息。
 */
import { type Db } from '@italent/db';
import { expect } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { allowAll, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export const ESIGN_BASE = '/api/tenant/esign';
export const ESIGN_SETTINGS_OBJECT = 'TenantBase.ESignSettings';

export interface TemplateView {
  id: string;
  code: string;
  name: string;
  body: string;
  status: 'enabled' | 'disabled';
  sortOrder: number;
  revision: number;
}

/** 拒绝配置对象 ESignSettings 的一切操作，其余全放行（模拟没有模板维护权的身份）。 */
export const denySettings: Authorizer = (q) => q.resource !== ESIGN_SETTINGS_OBJECT && !q.action.startsWith('admin.');

/** 拒绝调动 HR 按钮 Transfer.Hr，其余全放行。 */
export const denyTransferHr: Authorizer = (q) => !(q.action === 'object.button' && q.resource?.includes('Transfer.Hr'));

export async function esignWorld(db: Db, label: string, authorize: Authorizer = allowAll) {
  const session = await employmentSession(db, `f481-${label}-${uniqueSuffix()}`);
  const api = tenantApi(db, { authorize });
  const who = { user: session.user.id, tenant: session.tenant.id };
  const call = (method: string, path: string, options: { body?: unknown; ifMatch?: number } = {}) =>
    api.request(method, `${ESIGN_BASE}${path}`, { ...who, ...options });
  const template = (suffix: string, extra: Record<string, unknown> = {}) => ({
    code: `syn.esign.${suffix}_${uniqueSuffix()}`,
    name: `ZZ_F481_模板_${suffix}_${uniqueSuffix()}`,
    body: '{员工姓名}（工号 {工号}）自 {调动生效日期} 起由 {调出部门} 调入 {调入部门}。',
    ...extra,
  });
  async function create(suffix: string, extra: Record<string, unknown> = {}): Promise<TemplateView> {
    const response = await call('POST', '/templates', { body: template(suffix, extra) });
    expect(response.status, `创建模板：${await response.clone().text()}`).toBe(201);
    return (await response.json()) as TemplateView;
  }
  return { session, api, who, call, template, create };
}

export type EsignWorld = Awaited<ReturnType<typeof esignWorld>>;

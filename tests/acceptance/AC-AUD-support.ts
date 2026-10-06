/**
 * R1-T16 审计日志验收夹具（docs/02_业务建模/20 §5～§6；REQ-AUD-001）。
 * 审计查询接口挂在 /api/tenant/audit/ 之下；这里另起一个应用实例，用业务夹具里的同一租户 / 成员身份查询，
 * 时钟与业务写入对齐（查询窗口按租户保留期判定，DEC-056 事件时间存 UTC）。
 */
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { type RequestOptions, tenantApi } from './support/tenant-api.js';

export interface AuditOperator {
  readonly userId: string | null;
  readonly name: string;
}

export interface AuditChange {
  readonly field: string;
  readonly label: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly fromText: string;
  readonly toText: string;
}

export interface DataChangeLog {
  readonly id: string;
  readonly occurredAt: string;
  readonly operator: AuditOperator;
  readonly operation: 'create' | 'update' | 'delete' | 'other';
  readonly operationLabel: string;
  readonly app: string;
  readonly objectType: string;
  readonly objectLabel: string;
  readonly objectId: string;
  readonly action: string;
  readonly content: string;
  readonly changes: AuditChange[];
  readonly sourceAction: string | null;
  readonly sourcePage: string | null;
  readonly sourcePageType: string | null;
  readonly terminal: string | null;
  readonly clientVersion: string | null;
  readonly ip: string | null;
  readonly traceId: string | null;
  readonly commandId: string | null;
}

export interface DataChangeDetail extends DataChangeLog {
  readonly before: unknown;
  readonly after: unknown;
  readonly snapshot: Record<string, unknown> | null;
}

export interface OperationLog {
  readonly id: string;
  readonly occurredAt: string;
  readonly operator: AuditOperator;
  readonly behavior: string;
  readonly behaviorLabel: string;
  readonly objectType: string;
  readonly objectLabel: string;
  readonly objectId: string | null;
  readonly summary: string;
  readonly totalCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly result: 'succeeded' | 'partial' | 'failed';
  readonly errorReport: unknown;
  readonly ip: string | null;
  readonly terminal: string | null;
  readonly commandId: string | null;
}

export interface CommandFailureLog {
  readonly id: string;
  readonly occurredAt: string;
  readonly operator: AuditOperator;
  readonly outcome: 'business_failed' | 'storage_unwritable' | 'unknown';
  readonly outcomeLabel: string;
  readonly errorCode: string;
  readonly reason: string | null;
  readonly method: string | null;
  readonly path: string | null;
  readonly commandId: string;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly window: { readonly from: string; readonly to: string; readonly earliest: string };
}

/** 合成的请求来源（IP 用文档保留网段 203.0.113.0/24，RFC 5737）。 */
export const SOURCE_HEADERS = {
  'x-forwarded-for': '203.0.113.7, 10.0.0.1',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) SyntheticAudit/1.0',
  'x-client-version': '2026.10.1',
  'x-source-page': encodeURIComponent('员工档案/任职记录'),
  'x-source-page-type': encodeURIComponent('表单页'),
  'x-source-action': encodeURIComponent('编辑'),
  'x-trace-id': 'trace-aud-01',
} as const;

export function auditApi(db: Db, at: string | (() => Date), options: Parameters<typeof tenantApi>[1] = {}) {
  const clock = typeof at === 'string' ? () => new Date(at) : at;
  const api = tenantApi(db, { clock, ...options });
  const get = (path: string, as: { user: string; tenant: string }, extra: RequestOptions = {}) =>
    api.request('GET', `/api/tenant/audit${path}`, { ...as, ...extra });

  async function page<T>(path: string, as: { user: string; tenant: string }, query: Record<string, string> = {}) {
    const response = await get(`${path}?${new URLSearchParams(query)}`, as);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Page<T>;
  }

  return {
    api,
    get,
    dataChanges: (as: { user: string; tenant: string }, query: Record<string, string> = {}) =>
      page<DataChangeLog>('/data-changes', as, query),
    async dataChange(as: { user: string; tenant: string }, id: string): Promise<DataChangeDetail> {
      const response = await get(`/data-changes/${id}`, as);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as DataChangeDetail;
    },
    operationLogs: (as: { user: string; tenant: string }, query: Record<string, string> = {}) =>
      page<OperationLog>('/operation-logs', as, query),
    commandFailures: (as: { user: string; tenant: string }, query: Record<string, string> = {}) =>
      page<CommandFailureLog>('/command-failures', as, query),
  };
}

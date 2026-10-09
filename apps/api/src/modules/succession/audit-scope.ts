/**
 * 继任审计的查看规则登记位（R3-T05 设计 §8.4；DEC-197：审计复用业务对象自己的查看规则）。audit/visibility.ts
 * 按这里的种类套用通用谓词，PR-A～PR-D 只改本文件：
 * - org：按审计行写入时的所属组织（scope.orgId = 目标组织 / 职位所属组织 / 组织）裁剪，restrict 追加对象自己的谓词；
 * - seeAll：没有组织字段的规则配置对象，与业务读取同一规则，只认看全部（DEC-121）；
 * - rows：任务日志按逐行归属判定（至少一行可见才返回），未提供谓词时一律不返回（fail-closed）。
 * 审计对象类型 = 对象编码（与人才盘点、IDP 一致，audit/labels.ts 按编码显示中文名）。
 */
import { sql } from '@italent/db';
import type { SuccessionObject } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { ModuleScope } from '../permission/module-access.js';
import { selfRecordHiddenSql } from './read-sql.js';

/** 审计行可用的列（与 audit/visibility.ts 的 Row 同义）。 */
export interface SuccessionAuditRow {
  readonly objectId: SQL;
  readonly org: SQL;
  readonly before: SQL;
  readonly after: SQL;
  readonly commandId: SQL;
}

export interface SuccessionAuditViewer {
  readonly tenantId: string;
  readonly userId: string;
}

export type SuccessionAuditSpec =
  | { readonly kind: 'org'; readonly restrict?: (row: SuccessionAuditRow, viewer: SuccessionAuditViewer) => SQL }
  | { readonly kind: 'seeAll' }
  | {
      readonly kind: 'rows';
      readonly visible?: (scope: ModuleScope, row: SuccessionAuditRow, viewer: SuccessionAuditViewer) => SQL;
    };

/**
 * 继任记录日志的 SELF 谓词（§8.4：本人为目标的记录，开关为 false 时日志同样不可见）：目标取审计行写入时的快照
 * （after，删除时取 before）里的类型与目标 ID；快照里没有目标的行不属于“本人的”记录，照常按组织锚点判定。
 * 与列表 / 详情共用 succession_self_target_sql；“请求当日”按租户时区在 SQL 里取。
 */
function recordSelfRestrict(row: SuccessionAuditRow, viewer: SuccessionAuditViewer): SQL {
  const field = (key: string) => sql`COALESCE(${row.after}->>${key}, ${row.before}->>${key})`;
  const uuidField = (key: string) => sql`(CASE WHEN audit_is_uuid(${field(key)}) THEN (${field(key)})::uuid END)`;
  const today = sql`succession_tenant_today(${viewer.tenantId}::uuid)`;
  return sql`NOT ${selfRecordHiddenSql(
    viewer,
    { type: field('successionType'), org: uuidField('targetOrgId'), position: uuidField('targetPositionId') },
    today,
  )}`;
}

export const SUCCESSION_AUDIT: Readonly<Partial<Record<SuccessionObject, SuccessionAuditSpec>>> = {
  record: { kind: 'org', restrict: recordSelfRestrict },
  riskResult: { kind: 'org' },
  healthResult: { kind: 'org' },
  riskLevel: { kind: 'seeAll' },
  healthLevel: { kind: 'seeAll' },
  population: { kind: 'seeAll' },
  ruleSettings: { kind: 'seeAll' },
  calcRun: { kind: 'rows' },
  syncBatch: { kind: 'rows' },
};

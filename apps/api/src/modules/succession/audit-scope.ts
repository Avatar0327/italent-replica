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
 * 继任记录日志的 SELF 谓词（§8.4：本人为目标的记录，开关为 false 时日志同样不可见）。目标的确定顺序：
 * ① 审计行快照（after，删除时 before）里的类型与目标 ID；② 快照没有时（操作日志本身没有快照，单对象日志与 items 逐行
 * 日志都一样）按行的对象 ID 反查继任记录——目标建后不可改，反查结果与写入时一致，已软删除的记录同样可查。
 * 两处都确定不了目标（类型合法且有对应的目标 UUID）时 fail-closed（不放行）：无法证明“不是本人的”就不返回。与列表 / 详情共用
 * succession_self_target_sql；“请求当日”按租户时区在 SQL 里取。
 */
function recordSelfRestrict(row: SuccessionAuditRow, viewer: SuccessionAuditViewer): SQL {
  const objectId = sql`(CASE WHEN audit_is_uuid(${row.objectId}) THEN (${row.objectId})::uuid END)`;
  const stored = (column: string) =>
    sql`(SELECT r.${sql.raw(column)}::text FROM succession_records r
      WHERE r.tenant_id = ${viewer.tenantId}::uuid AND r.id = ${objectId})`;
  const field = (key: string, column: string) =>
    sql`COALESCE(${row.after}->>${key}, ${row.before}->>${key}, ${stored(column)})`;
  const uuidField = (key: string, column: string) =>
    sql`(CASE WHEN audit_is_uuid(${field(key, column)}) THEN (${field(key, column)})::uuid END)`;
  const type = field('successionType', 'succession_type');
  const org = uuidField('targetOrgId', 'target_org_id');
  const position = uuidField('targetPositionId', 'target_position_id');
  const today = sql`succession_tenant_today(${viewer.tenantId}::uuid)`;
  const hidden = selfRecordHiddenSql(viewer, { type, org, position }, today);
  // 目标确定 ⇔ 类型合法，且有与类型对应的目标 UUID；残缺快照（类型非法 / 缺目标 / 目标不是 UUID）一律不放行
  const determined = sql`(
    (${type} = 'org' AND ${org} IS NOT NULL) OR (${type} = 'position' AND ${position} IS NOT NULL))`;
  return sql`(${determined} AND NOT ${hidden})`;
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

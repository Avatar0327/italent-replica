/** 流程管理入口和审计共用活动 ∧ 人员谓词（设计 §5.1，P0 的规则注入位）。 */
import { sql } from '@italent/db';
import { EVALUATION_FLOW_OBJECTS } from '@italent/domain';
import { registerPersonScopedObject } from '../permission/scope-resolver.js';
import type { SQL } from 'drizzle-orm';
import { registerEvaluationFlowAuditRule } from '../../audit/visibility.js';
import { scopeSql } from '../permission/module-access.js';
import { type ModuleScope, scopePredicate } from './access.js';

// 同一应用的组织范围需要关联当前任职员工；复用平台登记位，不另行物化员工 ID 集合。
registerPersonScopedObject(EVALUATION_FLOW_OBJECTS.staffEvaluation.code);

export function activityPersonSql(scope: ModuleScope, alias = 'e'): SQL {
  const col = (name: string) => sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  return sql`EXISTS (SELECT 1 FROM ev_activities a WHERE a.tenant_id=${col('tenant_id')}
    AND a.id=${col('activity_id')} AND ${scopePredicate(scope, 'evaluationActivity', 'a')})
    AND ${scopeSql(scope, { person: col('employee_id'), creator: col('created_by') })}`;
}

export function registerFlowAudit(): void {
  registerEvaluationFlowAuditRule(
    (scope, row, viewer) => sql`EXISTS (
    SELECT 1 FROM ev_staff_evaluations e WHERE e.tenant_id=${viewer.tenantId}::uuid
      AND e.id::text=${row.objectId} AND ${activityPersonSql(scope)})`,
  );
}

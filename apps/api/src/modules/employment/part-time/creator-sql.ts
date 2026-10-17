/**
 * 兼职对象的创建人（数据范围“使用用户”维度；docs/08_设计/R2-T05_兼职设计.md §7.3A / §7.4）：重放复核与审计查看共用。
 * 创建人取最小元数据表 audit_object_creators（DEC-198，0058 触发器对所有 *.create 动作自动写入，不随审计保留期清理）。
 */
import { sql } from '@italent/db';
import type { SQL } from 'drizzle-orm';

/** 兼职记录：第 1 期来自申请（申请落地新增）时取申请发起人，否则取直接新增的操作人。recordId 为 uuid 表达式。 */
export function partTimeRecordCreator(tenantId: string, recordId: SQL): SQL {
  return sql`COALESCE(
    (SELECT q.initiator_user_id FROM employment_part_time_terms t
      JOIN part_time_requests q ON q.tenant_id=t.tenant_id AND q.id=t.source_id
      WHERE t.tenant_id=${tenantId} AND t.record_id=${recordId} AND t.term_no=1 AND t.source='create'),
    (SELECT a.creator_user_id FROM audit_object_creators a WHERE a.tenant_id=${tenantId}
      AND a.object_id=${recordId}::text AND a.action='employment.part_time.create'
      ORDER BY a.created_at LIMIT 1))`;
}

/** 兼职申请：发起人（申请头 initiator_user_id）。requestId 为 uuid 表达式。 */
export function partTimeRequestCreator(tenantId: string, requestId: SQL): SQL {
  return sql`(SELECT q.initiator_user_id FROM part_time_requests q
    WHERE q.tenant_id=${tenantId} AND q.id=${requestId})`;
}

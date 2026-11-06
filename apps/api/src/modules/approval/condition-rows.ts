/**
 * 条件项的落库与读回（发起条件与 F-478 分支条件共用同一套值载体规则）：
 * 列表值（in / not_in）进 value_list，单值进 value_text，is_empty / not_empty 两列都为空；读回时列表优先。
 */
import { sql, type Tx } from '@italent/db';
import type { ConditionItem } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { Row } from './context.js';

export function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

export function conditionItem(row: Row): ConditionItem {
  const value = (row.value_list as string[] | null) ?? (row.value_text as string | null);
  return {
    no: Number(row.item_no),
    field: String(row.field_path),
    operator: row.operator as ConditionItem['operator'],
    value,
  };
}

/** 写入哪张条件表：流程发起条件，或某节点出口某分支的条件。 */
export type ConditionTarget =
  | { readonly kind: 'initiation' }
  | { readonly kind: 'route'; readonly nodeKey: string; readonly exit: string; readonly branchNo: number };

export async function insertConditionItem(
  tx: Tx,
  tenantId: string,
  versionId: string,
  target: ConditionTarget,
  item: ConditionItem,
): Promise<void> {
  const list = Array.isArray(item.value) ? textArray(item.value as string[]) : sql`NULL`;
  const single = typeof item.value === 'string' ? item.value : null;
  if (target.kind === 'initiation') {
    await tx.execute(sql`INSERT INTO approval_process_conditions
      (tenant_id,version_id,item_no,field_path,operator,value_text,value_list)
      VALUES (${tenantId},${versionId}::uuid,${item.no},${item.field},${item.operator},${single},${list})`);
    return;
  }
  await tx.execute(sql`INSERT INTO approval_node_exit_route_conditions
    (tenant_id,version_id,node_key,exit,branch_no,item_no,field_path,operator,value_text,value_list)
    VALUES (${tenantId},${versionId}::uuid,${target.nodeKey},${target.exit},${target.branchNo},${item.no},
      ${item.field},${item.operator},${single},${list})`);
}

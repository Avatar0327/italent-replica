/**
 * 评价者的有效作答任务（F-084）：评价关系未移除、评价对象未移除。作答页、任务读写、头像名单与“我的待办”
 * 共用同一个定义——评价者在活动内一条有效任务也没有时，个人链接与待办入口一律按“链接无效”拒绝（DEC-379④）。
 */
import { sql, type SQL, type Tx } from '@italent/db';
import { rows } from './context.js';

const taskFrom = sql`FROM survey360_relations r
  JOIN survey360_objects o ON o.tenant_id = r.tenant_id AND o.id = r.object_id AND NOT o.removed
  JOIN survey360_people p ON p.tenant_id = o.tenant_id AND p.id = o.person_id
  JOIN survey360_roles ro ON ro.tenant_id = r.tenant_id AND ro.id = r.role_id`;

const taskWhere = (activityId: SQL | string, personId: SQL | string) =>
  sql`r.activity_id = ${activityId} AND r.appraiser_person_id = ${personId} AND NOT r.removed`;

export interface TaskRow {
  id: string;
  object_id: string;
  role_id: string;
  role_name: string;
  display_text: string | null;
  object_name: string;
  object_person_id: string;
}

export const taskQuery = (activityId: string, personId: string) => sql`SELECT r.id, r.object_id, r.role_id,
    ro.name AS role_name, ro.display_text, p.name AS object_name, p.id AS object_person_id
  ${taskFrom}
  WHERE ${taskWhere(sql`${activityId}::uuid`, sql`${personId}::uuid`)}`;

/** 相关子查询条件：activity / person 为外层查询的列引用。 */
export const hasValidTask = (activityId: SQL, personId: SQL): SQL =>
  sql`EXISTS (SELECT 1 ${taskFrom} WHERE ${taskWhere(activityId, personId)})`;

export async function hasTask(tx: Tx, activityId: string, personId: string): Promise<boolean> {
  const [found] = rows<{ ok: boolean }>(
    await tx.execute(sql`SELECT ${hasValidTask(sql`${activityId}::uuid`, sql`${personId}::uuid`)} AS ok`),
  );
  return found?.ok === true;
}

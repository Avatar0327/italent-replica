/** DEC-216：编制细分数组沿用容量详情的逐字段权限，容器可见不代表其中所有字段可见。 */
import { sql } from '@italent/db';
import type { SQL } from 'drizzle-orm';
export class CapacityAuditFields extends Set<string> {}
const PART_FIELDS = ['positionId', 'localCapacity', 'inclusiveCapacity'];

export function visibleCapacityParts(value: unknown, fields: ReadonlySet<string>): unknown {
  if (!Array.isArray(value)) return value;
  const allowed = PART_FIELDS.filter((key) => fields.has(key));
  if (!allowed.length) return [];
  return value.map((part: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(part).filter(([key]) => allowed.includes(key))),
  );
}

/** 投影发生在分页前；只改隐藏额度时，不能凭数组容器可见泄露事件存在或计数。 */
export function capacityAuditChanges(fields: CapacityAuditFields, source: SQL): SQL {
  const keys = PART_FIELDS.filter((key) => fields.has(key));
  const array = (value: SQL) => {
    if (!keys.length) return sql`'[]'::jsonb`;
    return sql`CASE WHEN jsonb_typeof(${value})='array' THEN
      (SELECT COALESCE(jsonb_agg((SELECT COALESCE(jsonb_object_agg(k,v),'{}'::jsonb)
        FROM jsonb_each(part) AS pair(k,v)
        WHERE k=ANY(${`{${keys.join(',')}}`}::text[])) ORDER BY ordinal), '[]'::jsonb)
        FROM jsonb_array_elements(${value}) WITH ORDINALITY AS parts(part,ordinal)) ELSE ${value} END`;
  };
  return sql`(SELECT COALESCE(jsonb_agg(projected ORDER BY ordinal), '[]'::jsonb) FROM (
    SELECT ordinal, CASE WHEN change->>'field' IN ('subdivisions','capacity.subdivisions')
      THEN (change-'fromText'-'toText') || jsonb_build_object(
        'from',${array(sql`change->'from'`)},'to',${array(sql`change->'to'`)}) ELSE change END AS projected
    FROM jsonb_array_elements(COALESCE(${source},'[]'::jsonb)) WITH ORDINALITY AS changes(change,ordinal)
  ) projected_changes WHERE projected->>'field' NOT LIKE 'delta.%'
    AND projected->'from' IS DISTINCT FROM projected->'to')`;
}

/**
 * 兼职区间派生的 SQL 镜像（docs/08_设计/R2-T05_兼职设计.md §1.2 / §6.1）：规则只有一份，在 domain employment/part-time.ts，
 * 这里给列表分页前过滤与视图计数用；逐点等价由 AC-PT-span-sql 断言（同 activation-store.ts finalExecutionDateSql 做法）。
 * 入参 start / end 是 date 列或表达式，today 是租户今天（DEC-056）。
 */
import { sql } from '@italent/db';
import { PART_TIME_EXPIRING_DAYS, type PartTimeRecordView, type PartTimeServiceStatus } from '@italent/domain';
import type { SQL } from 'drizzle-orm';

/** 期限链当前期（最大期号）的结束日；没有期限或无结束日期都是 NULL。 */
export function partTimeCurrentEndSql(tenantId: string, recordId: SQL): SQL {
  return sql`(SELECT t.end_date FROM employment_part_time_terms t WHERE t.tenant_id=${tenantId}
    AND t.record_id=${recordId} ORDER BY t.term_no DESC LIMIT 1)`;
}

export function partTimeEmptySql(start: SQL, end: SQL): SQL {
  return sql`(${end} IS NOT NULL AND ${end} < ${start})`;
}

export function partTimeCurrentSql(start: SQL, end: SQL, today: string): SQL {
  return sql`(${start} <= ${today}::date AND (${end} IS NULL OR ${today}::date <= ${end}))`;
}

const ended = (start: SQL, end: SQL, today: string) =>
  sql`(${partTimeEmptySql(start, end)} OR (${end} IS NOT NULL AND ${end} < ${today}::date))`;

export function partTimeServiceStatusSql(start: SQL, end: SQL, today: string): SQL {
  const status = (value: PartTimeServiceStatus) => sql`${value}::text`;
  return sql`(CASE WHEN ${ended(start, end, today)} THEN ${status('ended')} ELSE ${status('serving')} END)`;
}

export function partTimeViewSql(
  view: PartTimeRecordView,
  start: SQL,
  end: SQL,
  today: string,
  expiringDays: number = PART_TIME_EXPIRING_DAYS.default,
): SQL {
  switch (view) {
    case 'all':
      return sql`true`;
    case 'ongoing':
      return partTimeCurrentSql(start, end, today);
    case 'expiring':
      return sql`(${partTimeCurrentSql(start, end, today)} AND ${end} IS NOT NULL
        AND ${end} <= ${today}::date + ${expiringDays}::int)`;
    case 'not_started':
      return sql`(NOT ${partTimeEmptySql(start, end)} AND ${start} > ${today}::date)`;
    case 'ended':
      return ended(start, end, today);
  }
}

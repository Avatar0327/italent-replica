/**
 * BE-7 PT-2 PB-06（SQL 侧，docs/08_设计/R2-T05_兼职设计.md §1.2 / §6.1）：兼职任职状态与视图归属只有一份规则——
 * 纯函数 domain employment/part-time.ts ≡ SQL 镜像 part-time/span-sql.ts，在开始日前一天、开始日、结束日、结束日次日、
 * 空区间、无结束日期、即将到期边界上逐点相等；期限链当前期取最大期号。
 */
import { sql, withTenant } from '@italent/db';
import { inPartTimeView, PART_TIME_RECORD_VIEWS, partTimeServiceStatus } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import {
  partTimeCurrentEndSql,
  partTimeServiceStatusSql,
  partTimeViewSql,
} from '../../apps/api/src/modules/employment/part-time/span-sql.js';
import { partTimeWorld } from './AC-PT-support.js';

const database = useTestDb();

const SPANS = [
  { startDate: '2026-10-10', endDate: '2026-10-20' },
  { startDate: '2026-10-10', endDate: '2026-10-10' },
  { startDate: '2026-10-10', endDate: '2026-10-09' },
  { startDate: '2026-10-10', endDate: null },
  { startDate: '2026-10-10', endDate: '2026-11-08' },
  { startDate: '2026-10-10', endDate: '2026-11-09' },
] as const;
const TODAYS = ['2026-10-09', '2026-10-10', '2026-10-20', '2026-10-21', '2026-11-08', '2026-11-09'];

describe('AC-PT-span-sql PB-06：SQL ≡ 纯函数', () => {
  it('任职状态与五个记录视图（含即将到期 30 / 31 天）逐点相等', async () => {
    const start = sql`s.start_date`;
    const end = sql`s.end_date`;
    const input = SPANS.map((span, ord) => ({ ord, start_date: span.startDate, end_date: span.endDate }));
    for (const today of TODAYS)
      for (const days of [30, 31]) {
        const views = sql.join(
          PART_TIME_RECORD_VIEWS.map((view) => sql`${partTimeViewSql(view, start, end, today, days)}`),
          sql`, `,
        );
        const rows = rowsOf<{ ord: number; status: string; views: boolean[] }>(
          await database().db.execute(sql`
            SELECT s.ord, ${partTimeServiceStatusSql(start, end, today)} AS status, ARRAY[${views}] AS views
            FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) AS s(ord int, start_date date, end_date date)
            ORDER BY s.ord`),
        );
        expect(
          rows.map((row) => ({ status: row.status, views: row.views })),
          `${today} / ${days}`,
        ).toEqual(
          SPANS.map((span) => ({
            status: partTimeServiceStatus(span, today),
            views: PART_TIME_RECORD_VIEWS.map((view) => inPartTimeView(view, span, today, days)),
          })),
        );
      }
  });

  it('当前期取最大期号的结束日：无期限 / 无结束日期为 NULL', async () => {
    const w = await partTimeWorld(database().db, 'span-term');
    const ids: string[] = [];
    expect(
      await w.attempt(async (tx) => {
        for (let i = 0; i < 3; i += 1) ids.push(await w.insertPartTime(tx));
        await tx.execute(w.term(ids[0]!, 1, '2026-12-31', 'create'));
        await tx.execute(w.term(ids[0]!, 2, '2026-10-15', 'end'));
        await tx.execute(w.term(ids[1]!, 1, null, 'create'));
      }),
    ).toBeUndefined();
    const ends = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ id: string; end: string | null }>(
        await tx.execute(sql`SELECT r.id, ${partTimeCurrentEndSql(w.tenantId, sql`r.id`)}::text AS end
          FROM employment_records r WHERE r.tenant_id=${w.tenantId} AND r.service_type <> 'primary'`),
      ),
    );
    expect(new Map(ends.map((row) => [row.id, row.end]))).toEqual(
      new Map([
        [ids[0], '2026-10-15'],
        [ids[1], null],
        [ids[2], null],
      ]),
    );
  });
});

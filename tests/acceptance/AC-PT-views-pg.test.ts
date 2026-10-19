/**
 * BE-7 PT-5 六视图在真 PostgreSQL 下的口径（docs/08_设计/R2-T05_兼职设计.md §13.3 PT-5 行；PGlite 下同样运行，两个引擎结果必须一致）：
 * - 租户时区跨日：UTC 还是 10-01 而租户已是 10-02（Asia/Shanghai）时，六视图归属与 total 按租户今天算，且与 domain 纯函数逐条一致；
 * - DEC-177 范围谓词分页前过滤：范围外记录不占页位、不计入 total，范围内的翻页稳定且不重不漏；
 * - RLS：跨租户不可见（视图、详情、直连 SQL 都读不到别的租户的兼职与申请）。
 */
import { sql, withTenant } from '@italent/db';
import { inPartTimeView, PART_TIME_RECORD_VIEWS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { restricted } from './AC-PT-http-support.js';
import { MATRIX, viewsWorld, type MatrixKey } from './AC-PT-views-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const world = (label: string) => viewsWorld(database().db, label);

/** UTC 10-01 17:30 = 租户（Asia/Shanghai）10-02 01:30：UTC 日期与租户日期差一天。 */
const NEXT_DAY_IN_TENANT = () => new Date('2026-10-01T17:30:00.000Z');

describe('租户时区跨日的 today 边界', () => {
  it('租户今天 = 10-02：结束日 10-01 已结束、明天开始的已开始、第 31 天进入即将到期', async () => {
    const w = await world('views-pg-tz');
    const ids = await w.seedMatrix();
    const send = (query: string) => w.as(restricted({}), NEXT_DAY_IN_TENANT)('GET', `/part-times?${query}`);
    const keys = async (view: string) => w.keysOf(ids, w.idsOf(await w.ok(await send(`view=${view}`)))).sort();
    expect(await keys('ongoing')).toEqual(['endsDay30', 'endsDay31', 'open', 'startsToday', 'startsTomorrow']);
    expect(await keys('expiring')).toEqual(['endsDay30', 'endsDay31']);
    expect(await keys('not_started')).toEqual([]);
    expect(await keys('ended')).toEqual(['emptySpan', 'endedYesterday', 'endsToday', 'sameDay']);
    expect((await w.ok<{ total: number }>(await send('view=all'))).total).toBe(9);
  });

  it.each([
    ['租户今天 = 10-01（UTC 同日）', () => new Date('2026-10-01T01:00:00.000Z'), '2026-10-01'],
    ['租户今天 = 10-02（UTC 还是 10-01）', NEXT_DAY_IN_TENANT, '2026-10-02'],
  ])('%s：SQL 视图与 domain 纯函数逐条一致', async (_name, clock, today) => {
    const w = await world('views-pg-equivalence');
    const ids = await w.seedMatrix();
    for (const view of PART_TIME_RECORD_VIEWS) {
      const body = await w.ok<{ items: { id: string }[]; total: number }>(
        await w.as(restricted({}), clock)('GET', `/part-times?view=${view}`),
      );
      const expected = (Object.keys(MATRIX) as MatrixKey[])
        .filter((key) => {
          const [startDate, endDate] = MATRIX[key];
          return inPartTimeView(view, { startDate, endDate }, today);
        })
        .map((key) => ids[key])
        .sort();
      expect([view, body.items.map((item) => item.id).sort(), body.total]).toEqual([view, expected, expected.length]);
    }
  });
});

describe('DEC-177 范围谓词分页前过滤', () => {
  it('范围外记录交错在范围内记录之间：翻页不重不漏，total 只数范围内', async () => {
    const w = await world('views-pg-scope');
    const hidden = await w.org(`范围外${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    // 开始日期交错：奇数天落在范围内部门，偶数天落在范围外部门（员工主职部门不在范围，只剩记录部门这一项）
    const inside: string[] = [];
    for (let day = 1; day <= 8; day += 1) {
      const startDate = `2026-09-${String(day).padStart(2, '0')}`;
      const id = await w.seedPartTime({ startDate, endDate: null });
      if (day % 2 === 0) await w.moveSnapshot(id, hidden.id);
      else inside.push(id);
    }
    const send = w.getAs(restricted({ scope: w.scopeOf(w.partTimeOrg.id) }));
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const body = await w.view('all', `&pageSize=2&page=${page}`, send);
      expect(body.total).toBe(4);
      seen.push(...w.idsOf(body));
    }
    expect(seen).toEqual([...inside].reverse());
    expect((await w.view('all', '&pageSize=2&page=4', send)).items).toEqual([]);
  });
});

describe('RLS：跨租户不可见', () => {
  it('租户 B 的兼职与申请，租户 A 在视图、详情、直连 SQL 里都读不到', async () => {
    const a = await world('views-pg-rls-a');
    const b = await world('views-pg-rls-b');
    await a.seedMatrix();
    const bRecord = await b.seedPartTime({ startDate: '2026-09-01', endDate: null });
    const bRequest = await b.seedRequest({ requestType: 'add' });
    const all = await a.view('all');
    expect(all.total).toBe(9);
    expect(a.idsOf(all)).not.toContain(bRecord);
    expect((await a.view('in_approval')).items.map((item) => item.id)).not.toContain(bRequest);
    expect((await a.get(`/part-times/${bRecord}`)).status).toBe(404);
    // 租户 B 的部门 ID 当筛选条件：租户 A 看到空集
    expect((await a.view('all', `&departmentId=${b.partTimeOrg.id}`)).total).toBe(0);
    // 直连 SQL（租户 A 的会话变量）读不到租户 B 的期限与申请
    const counts = await withTenant(a.db, a.tenantId, async (tx) =>
      rowsOf<{ terms: number; requests: number }>(
        await tx.execute(sql`SELECT
          (SELECT count(*)::int FROM employment_part_time_terms WHERE record_id=${bRecord}::uuid) AS terms,
          (SELECT count(*)::int FROM part_time_requests WHERE id=${bRequest}::uuid) AS requests`),
      ),
    );
    expect(counts).toEqual([{ terms: 0, requests: 0 }]);
  });
});

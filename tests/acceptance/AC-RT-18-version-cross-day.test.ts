/**
 * F-276 / AC-RT-18：退休视图“人事版本按 asOf 当日结束取最新”的跨日回归（设计 R2-T04 §10.1、§10.2 测试要求）。
 * 员工行的 P / 弹性上下限取 created_at < asOf 次日 0 点（租户时区 Asia/Shanghai）的最新人事版本；删掉这个时间截止条件，
 * AC-RT-18 其余用例仍全绿（P 只在 TODAY 写过一次），所以这里用写死的版本时刻单独覆盖：
 * 跨日（16 日改 P，回查 15 日仍用 15 日日末前的版本）、同日多版本（取当日最后一版）、日末边界（23:59:59 与次日 00:00:00）。
 * 每个版本的 P 与弹性上下限互不相同，SQL 逐 asOf 断言整行（员工 ID、姓名、P、上下限、到期天数），纯函数断言具体视图与员工 ID；
 * 员工 ID 由建人接口生成，夹具建完即固定为“场景 → 员工 ID”表，期望按这张表写死，不从响应反推。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { addDays, classifyRetirement, type RetirementPersonView } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { appendEmployee } from '../../apps/api/src/modules/personnel/employee-write.js';
import { retirementWorld } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const HIRE = '2026-09-01';
const DAYS = 30;
/** 租户时区 Asia/Shanghai = UTC+8：租户日 D 的 23:59:59 = D 日 15:59:59Z，次日 00:00:00 = D 日 16:00:00Z。 */
const SHANGHAI = '+08:00';

/** 写死的人事版本：at 为绝对时刻（UTC），p 为预计退休日期，lo / hi 为弹性下限 / 上限；按时间升序，全部互不相同。 */
interface Version {
  readonly at: string;
  readonly p: string;
  readonly lo: string;
  readonly hi: string;
}
const v = (at: string, p: string, lo: string, hi: string): Version => ({ at, p, lo, hi });
const SCENARIOS = {
  // 16 日改成远期：15 日仍用 15 日日末前的 v0（P = 10-20，即将）
  跨日后改远: [
    v('2026-10-10T02:00:00Z', '2026-10-20', '2026-10-01', '2026-10-31'),
    v('2026-10-16T02:00:00Z', '2026-12-31', '2026-12-01', '2027-01-31'),
  ],
  // 16 日改成已过期：15 日仍用 v0（P = 12-31，不进任何视图）
  跨日后改近: [
    v('2026-10-10T02:00:00Z', '2026-12-31', '2026-12-01', '2027-01-31'),
    v('2026-10-16T02:00:00Z', '2026-10-10', '2026-09-15', '2026-10-12'),
  ],
  // 15 日当天连写三版：当日取最后一版（P = 10-25），第一版 10-01（过期）、第二版 11-30（远期）都不能取到
  同日多版本: [
    v('2026-10-13T02:00:00Z', '2026-10-01', '2026-09-20', '2026-10-05'),
    v('2026-10-15T01:00:00Z', '2026-11-30', '2026-11-01', '2026-12-15'),
    v('2026-10-15T05:00:00Z', '2026-10-01', '2026-09-25', '2026-10-03'),
    v('2026-10-15T12:00:00Z', '2026-10-25', '2026-10-10', '2026-11-10'),
  ],
  // 15 日 23:59:59（租户时区）仍算 15 日
  日末前一秒: [
    v('2026-10-10T02:00:00Z', '2026-11-30', '2026-11-10', '2026-12-20'),
    v('2026-10-15T15:59:59Z', '2026-10-21', '2026-10-11', '2026-10-31'),
  ],
  // 16 日 00:00:00（租户时区）已是 16 日，15 日仍用旧版（UTC 日仍是 15 日，用 UTC 折算会取到）
  日末当刻: [
    v('2026-10-10T02:00:00Z', '2026-11-30', '2026-11-11', '2026-12-21'),
    v('2026-10-15T16:00:00Z', '2026-10-22', '2026-10-12', '2026-11-01'),
  ],
} as const satisfies Record<string, readonly Version[]>;
type Name = keyof typeof SCENARIOS;
const NAMES = Object.keys(SCENARIOS) as Name[];

/** 写死的期望行：视图里按 P 升序的“场景 + asOf 时取到的 P / 下限 / 上限 + 到期天数（P − asOf）”。 */
interface Row {
  readonly who: Name;
  readonly p: string;
  readonly lo: string;
  readonly hi: string;
  readonly days: number;
}
const row = (who: Name, p: string, lo: string, hi: string, days: number): Row => ({ who, p, lo, hi, days });
type Views = Record<RetirementPersonView, readonly Row[]>;
const EXPECTED: Record<string, Views> = {
  // 同日多版本的三版全在 14 日日末之后，回落到 10-13 的 v0（P = 10-01，过期）
  '2026-10-14': {
    upcoming: [row('跨日后改远', '2026-10-20', '2026-10-01', '2026-10-31', 6)],
    overdue: [row('同日多版本', '2026-10-01', '2026-09-20', '2026-10-05', -13)],
  },
  '2026-10-15': {
    upcoming: [
      row('跨日后改远', '2026-10-20', '2026-10-01', '2026-10-31', 5),
      row('日末前一秒', '2026-10-21', '2026-10-11', '2026-10-31', 6),
      row('同日多版本', '2026-10-25', '2026-10-10', '2026-11-10', 10),
    ],
    overdue: [],
  },
  '2026-10-16': {
    upcoming: [
      row('日末前一秒', '2026-10-21', '2026-10-11', '2026-10-31', 5),
      row('日末当刻', '2026-10-22', '2026-10-12', '2026-11-01', 6),
      row('同日多版本', '2026-10-25', '2026-10-10', '2026-11-10', 9),
    ],
    overdue: [row('跨日后改近', '2026-10-10', '2026-09-15', '2026-10-12', -6)],
  },
};
/** 写死的“asOf 时取到的 P”（手算，下标 = asOf − 10-12，即 10-12 ~ 10-18 逐日；null = 该日日末前尚无退休日期），纯函数一侧据此分类。 */
const P = {
  跨日后改远: ['2026-10-20', '2026-10-20', '2026-10-20', '2026-10-20', '2026-12-31', '2026-12-31', '2026-12-31'],
  跨日后改近: ['2026-12-31', '2026-12-31', '2026-12-31', '2026-12-31', '2026-10-10', '2026-10-10', '2026-10-10'],
  同日多版本: [null, '2026-10-01', '2026-10-01', '2026-10-25', '2026-10-25', '2026-10-25', '2026-10-25'],
  日末前一秒: ['2026-11-30', '2026-11-30', '2026-11-30', '2026-10-21', '2026-10-21', '2026-10-21', '2026-10-21'],
  日末当刻: ['2026-11-30', '2026-11-30', '2026-11-30', '2026-11-30', '2026-10-22', '2026-10-22', '2026-10-22'],
} as const satisfies Record<Name, readonly (string | null)[]>;
const DAY_INDEX = (asOf: string) => Number(asOf.slice(8)) - 12;

/** 手写的版本取值：asOf 当日结束（租户时区次日 0 点）之前的最后一版。 */
function resolve(versions: readonly Version[], asOf: string): Version | null {
  const dayEnd = Date.parse(`${addDays(asOf, 1)}T00:00:00${SHANGHAI}`);
  const known = versions.filter((version) => Date.parse(version.at) < dayEnd);
  return known.length ? known[known.length - 1]! : null;
}
const classify = (asOf: string, expectedDate: string | null) =>
  classifyRetirement({
    asOf,
    upcomingDays: DAYS,
    person: { active: true, staffId: 'cycle-1', cycleEntryDate: HIRE, expectedDate },
    bills: [],
  }).person;

interface ViewItem {
  employeeId: string;
  name: string;
  expectedRetirementDate: string;
  earliestRetirementDate: string;
  latestRetirementDate: string;
  daysToRetirement: number;
}
interface ViewPage {
  items: ViewItem[];
  total: number;
}

describe('AC-RT-18 人事版本跨日取值（asOf 当日结束，租户时区）', () => {
  const ids = {} as Record<Name, string>;
  let page: (view: RetirementPersonView, asOf: string) => Promise<ViewItem[]>;
  /** 把期望行折成响应字段，员工 ID 用夹具固定下来的那张表。 */
  const expectItems = (rows: readonly Row[]) =>
    rows.map((r) => ({
      employeeId: ids[r.who],
      name: r.who,
      expectedRetirementDate: r.p,
      earliestRetirementDate: r.lo,
      latestRetirementDate: r.hi,
      daysToRetirement: r.days,
    }));
  const project = (items: ViewItem[]) =>
    items.map(
      ({
        employeeId,
        name,
        expectedRetirementDate,
        earliestRetirementDate,
        latestRetirementDate,
        daysToRetirement,
      }) => ({
        employeeId,
        name,
        expectedRetirementDate,
        earliestRetirementDate,
        latestRetirementDate,
        daysToRetirement,
      }),
    );

  beforeAll(async () => {
    const x = await retirementWorld(database().db, 'rt18-xday', TODAY);
    expect(x.session.tenant.timezone).toBe('Asia/Shanghai');
    for (const who of NAMES) {
      const { employee } = await x.hired(who);
      ids[who] = employee.id;
      for (const version of SCENARIOS[who]) {
        // created_at 取 ctx.now：按写死的绝对时刻追加人事版本（revision 与时间同序）
        await withTenant(database().db, x.session.tenant.id, (tx) =>
          appendEmployee(
            tx,
            {
              tenantId: x.session.tenant.id,
              userId: x.session.user.id,
              timezone: x.session.tenant.timezone,
              now: new Date(version.at),
              commandId: randomUUID(),
              expectedRevision: 0,
            } as never,
            employee.id,
            {
              expectedRetirementDate: version.p,
              earliestRetirementDate: version.lo,
              latestRetirementDate: version.hi,
            },
            false,
          ),
        );
      }
    }
    page = async (view, asOf) => {
      const response = await x.session.request('GET', `/retirements?view=${view}&asOf=${asOf}&upcomingDays=${DAYS}`);
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as ViewPage;
      expect(body.total).toBe(body.items.length);
      return body.items;
    };
  });

  it('夹具自检：员工 ID 互不相同；手写版本取值与写死的 P 表、期望行一致（期望不依赖被测实现）', () => {
    expect(new Set(Object.values(ids)).size).toBe(NAMES.length);
    for (let i = 0; i < 7; i += 1) {
      const asOf = addDays('2026-10-12', i);
      for (const who of NAMES) expect(resolve(SCENARIOS[who], asOf)?.p ?? null, `${asOf} ${who}`).toBe(P[who][i]);
    }
    for (const [asOf, views] of Object.entries(EXPECTED))
      for (const r of [...views.upcoming, ...views.overdue]) {
        const picked = resolve(SCENARIOS[r.who], asOf)!;
        expect([picked.p, picked.lo, picked.hi], `${asOf} ${r.who}`).toEqual([r.p, r.lo, r.hi]);
        expect(Date.parse(r.p) - Date.parse(asOf), `${asOf} ${r.who} 天数`).toBe(r.days * 86_400_000);
      }
  });

  it('SQL：跨日 / 同日多版本 / 日末边界逐 asOf 取到写死的整行（员工 ID、姓名、P、上下限、到期天数）', async () => {
    for (const [asOf, views] of Object.entries(EXPECTED))
      for (const view of ['upcoming', 'overdue'] as const)
        expect(project(await page(view, asOf)), `${view} asOf=${asOf}`).toEqual(expectItems(views[view]));
  });

  it('SQL 跨日：16 日改 P / 上下限后，回查 15 日仍返回 15 日日末前版本的字段；16 日起返回新版本', async () => {
    const far15 = (await page('upcoming', '2026-10-15')).find((item) => item.employeeId === ids.跨日后改远);
    expect(far15).toMatchObject({
      expectedRetirementDate: '2026-10-20',
      earliestRetirementDate: '2026-10-01',
      latestRetirementDate: '2026-10-31',
    });
    expect((await page('upcoming', '2026-10-16')).map((item) => item.employeeId)).not.toContain(ids.跨日后改远);
    expect((await page('overdue', '2026-10-15')).map((item) => item.employeeId)).not.toContain(ids.跨日后改近);
    expect(project(await page('overdue', '2026-10-16'))).toEqual(expectItems(EXPECTED['2026-10-16']!.overdue));
  });

  it('SQL 日末边界：租户时区 23:59:59 属当日，次日 00:00:00 属次日（不按 UTC 日折算）', async () => {
    const fifteenth = await page('upcoming', '2026-10-15');
    expect(fifteenth.find((item) => item.employeeId === ids.日末前一秒)).toMatchObject({
      expectedRetirementDate: '2026-10-21',
      earliestRetirementDate: '2026-10-11',
      latestRetirementDate: '2026-10-31',
    });
    expect(fifteenth.map((item) => item.employeeId)).not.toContain(ids.日末当刻);
    const sixteenth = await page('upcoming', '2026-10-16');
    expect(sixteenth.find((item) => item.employeeId === ids.日末当刻)).toMatchObject({
      expectedRetirementDate: '2026-10-22',
      earliestRetirementDate: '2026-10-12',
      latestRetirementDate: '2026-11-01',
    });
  });

  it('纯函数 classifyRetirement：同一张期望表（P 由手写版本取值给出），按员工 ID 断言具体视图与行', () => {
    for (const [asOf, views] of Object.entries(EXPECTED)) {
      const classified = NAMES.map((who) => ({
        who,
        p: P[who][DAY_INDEX(asOf)] ?? '',
        view: classify(asOf, P[who][DAY_INDEX(asOf)] ?? null),
      }));
      const pick = (want: RetirementPersonView) =>
        classified
          .filter((c) => c.view === want)
          .sort((a, b) => a.p.localeCompare(b.p))
          .map((c) => ids[c.who]);
      expect(pick('upcoming'), `upcoming asOf=${asOf}`).toEqual(views.upcoming.map((r) => ids[r.who]));
      expect(pick('overdue'), `overdue asOf=${asOf}`).toEqual(views.overdue.map((r) => ids[r.who]));
    }
  });

  it('逐日对照：10-12 ~ 10-18 每个 asOf，SQL 行集合 ≡ 纯函数（版本取值手写）', async () => {
    for (let i = 0; i < 7; i += 1) {
      const asOf = addDays('2026-10-12', i);
      for (const want of ['upcoming', 'overdue'] as const) {
        const expected = NAMES.filter((who) => classify(asOf, P[who][i]) === want).map((who) => ids[who]);
        const actual = (await page(want, asOf)).map((item) => item.employeeId);
        expect([...actual].sort(), `${want} asOf=${asOf}`).toEqual([...expected].sort());
      }
    }
  });
});

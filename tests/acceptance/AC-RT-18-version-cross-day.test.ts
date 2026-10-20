/**
 * F-276 / AC-RT-18：退休视图“人事版本按 asOf 当日结束取最新”的跨日回归（设计 R2-T04 §10.1、§10.2 测试要求）。
 * 员工行的 P 取 created_at < asOf 次日 0 点（租户时区 Asia/Shanghai）的最新人事版本；删掉这个时间截止条件，
 * AC-RT-18 其余用例仍全绿（P 只在 TODAY 写过一次），所以这里用写死的版本时刻单独覆盖：
 * 跨日（16 日改 P，回查 15 日仍用 15 日日末前的版本）、同日多版本（取当日最后一版）、日末边界（23:59:59 与次日 00:00:00）。
 * SQL 与纯函数各自对同一张写死的期望表断言具体视图与员工 ID；纯函数一侧的 P 由测试内手写的“版本取值”给出，不读库。
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

/** 写死的人事版本：at 为绝对时刻（UTC），p 为该版本的预计退休日期，按时间升序。 */
type Version = { readonly at: string; readonly p: string | null };
const SCENARIOS = {
  // 16 日改成远期：15 日仍用 15 日日末前的 v0（P = 10-20，即将）
  跨日后改远: [
    { at: '2026-10-10T02:00:00Z', p: '2026-10-20' },
    { at: '2026-10-16T02:00:00Z', p: '2026-12-31' },
  ],
  // 16 日改成已过期：15 日仍用 v0（P = 12-31，不进任何视图）
  跨日后改近: [
    { at: '2026-10-10T02:00:00Z', p: '2026-12-31' },
    { at: '2026-10-16T02:00:00Z', p: '2026-10-10' },
  ],
  // 15 日当天连写三版：当日取最后一版（P = 10-25），第一版 10-01（过期）、第二版 11-30（远期）都不能取到
  同日多版本: [
    { at: '2026-10-13T02:00:00Z', p: '2026-10-01' },
    { at: '2026-10-15T01:00:00Z', p: '2026-11-30' },
    { at: '2026-10-15T05:00:00Z', p: '2026-10-01' },
    { at: '2026-10-15T12:00:00Z', p: '2026-10-25' },
  ],
  // 15 日 23:59:59（租户时区）仍算 15 日
  日末前一秒: [
    { at: '2026-10-10T02:00:00Z', p: '2026-11-30' },
    { at: '2026-10-15T15:59:59Z', p: '2026-10-21' },
  ],
  // 16 日 00:00:00（租户时区）已是 16 日，15 日仍用旧版（UTC 日仍是 15 日，用 UTC 折算会取到）
  日末当刻: [
    { at: '2026-10-10T02:00:00Z', p: '2026-11-30' },
    { at: '2026-10-15T16:00:00Z', p: '2026-10-22' },
  ],
} as const satisfies Record<string, readonly Version[]>;
type Name = keyof typeof SCENARIOS;
const NAMES = Object.keys(SCENARIOS) as Name[];

/** 写死的期望：asOf → 视图 → 员工（按 P 升序，括号内为 asOf 时取到的 P）。 */
const EXPECTED: Record<string, Record<RetirementPersonView, readonly Name[]>> = {
  // 同日多版本的三版全在 14 日日末之后，回落到 10-13 的 v0（P = 10-01，过期）
  '2026-10-14': { upcoming: ['跨日后改远'], overdue: ['同日多版本'] },
  '2026-10-15': { upcoming: ['跨日后改远', '日末前一秒', '同日多版本'], overdue: [] },
  '2026-10-16': { upcoming: ['日末前一秒', '日末当刻', '同日多版本'], overdue: ['跨日后改近'] },
};
/** 写死的“asOf 时取到的 P”（手算），纯函数一侧的版本取值必须与它一致。 */
const RESOLVED_P: Record<string, Record<Name, string>> = {
  '2026-10-14': {
    跨日后改远: '2026-10-20',
    跨日后改近: '2026-12-31',
    同日多版本: '2026-10-01',
    日末前一秒: '2026-11-30',
    日末当刻: '2026-11-30',
  },
  '2026-10-15': {
    跨日后改远: '2026-10-20',
    跨日后改近: '2026-12-31',
    同日多版本: '2026-10-25',
    日末前一秒: '2026-10-21',
    日末当刻: '2026-11-30',
  },
  '2026-10-16': {
    跨日后改远: '2026-12-31',
    跨日后改近: '2026-10-10',
    同日多版本: '2026-10-25',
    日末前一秒: '2026-10-21',
    日末当刻: '2026-10-22',
  },
};

/** 手写的版本取值：asOf 当日结束（租户时区次日 0 点）之前的最后一版。 */
function resolveP(versions: readonly Version[], asOf: string): string | null {
  const dayEnd = Date.parse(`${addDays(asOf, 1)}T00:00:00${SHANGHAI}`);
  const known = versions.filter((v) => Date.parse(v.at) < dayEnd);
  return known.length ? known[known.length - 1]!.p : null;
}

interface ViewPage {
  items: { employeeId: string }[];
  total: number;
}

describe('AC-RT-18 人事版本跨日取值（asOf 当日结束，租户时区）', () => {
  const employees = new Map<Name, string>();
  const nameOf = new Map<string, Name>();
  let view: (name: RetirementPersonView, asOf: string) => Promise<Name[]>;

  beforeAll(async () => {
    const x = await retirementWorld(database().db, 'rt18-xday', TODAY);
    expect(x.session.tenant.timezone).toBe('Asia/Shanghai');
    for (const name of NAMES) {
      const { employee } = await x.hired(`${name}-${randomUUID()}`);
      employees.set(name, employee.id);
      nameOf.set(employee.id, name);
      for (const version of SCENARIOS[name]) {
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
            { expectedRetirementDate: version.p },
            false,
          ),
        );
      }
    }
    view = async (name, asOf) => {
      const response = await x.session.request('GET', `/retirements?view=${name}&asOf=${asOf}&upcomingDays=${DAYS}`);
      expect(response.status, await response.clone().text()).toBe(200);
      const page = (await response.json()) as ViewPage;
      expect(page.total).toBe(page.items.length);
      return page.items.map((item) => nameOf.get(item.employeeId)!);
    };
  });

  it('夹具自检：手写的版本取值与写死的 P 表一致（期望表不依赖被测实现）', () => {
    for (const [asOf, table] of Object.entries(RESOLVED_P))
      for (const name of NAMES) expect(resolveP(SCENARIOS[name], asOf), `${asOf} ${name}`).toBe(table[name]);
  });

  it('SQL：跨日 / 同日多版本 / 日末边界逐 asOf 取到写死的视图与员工', async () => {
    for (const [asOf, views] of Object.entries(EXPECTED)) {
      expect(await view('upcoming', asOf), `upcoming asOf=${asOf}`).toEqual(views.upcoming);
      expect(await view('overdue', asOf), `overdue asOf=${asOf}`).toEqual(views.overdue);
    }
  });

  it('SQL 跨日：16 日改 P 后，回查 15 日仍用 15 日日末前的版本；16 日起用新版本', async () => {
    expect(await view('upcoming', '2026-10-15')).toContain('跨日后改远');
    expect(await view('upcoming', '2026-10-16')).not.toContain('跨日后改远');
    expect(await view('overdue', '2026-10-15')).not.toContain('跨日后改近');
    expect(await view('overdue', '2026-10-16')).toEqual(['跨日后改近']);
  });

  it('SQL 日末边界：租户时区 23:59:59 属当日，次日 00:00:00 属次日（不按 UTC 日折算）', async () => {
    const fifteenth = await view('upcoming', '2026-10-15');
    expect(fifteenth).toContain('日末前一秒');
    expect(fifteenth).not.toContain('日末当刻');
    expect(await view('upcoming', '2026-10-16')).toEqual(expect.arrayContaining(['日末前一秒', '日末当刻']));
  });

  it('纯函数 classifyRetirement：同一张期望表（P 由手写版本取值给出）', () => {
    for (const [asOf, views] of Object.entries(EXPECTED)) {
      const classified = NAMES.map((name) => ({
        name,
        p: resolveP(SCENARIOS[name], asOf)!,
        view: classifyRetirement({
          asOf,
          upcomingDays: DAYS,
          person: {
            active: true,
            staffId: 'cycle-1',
            cycleEntryDate: HIRE,
            expectedDate: resolveP(SCENARIOS[name], asOf),
          },
          bills: [],
        }).person,
      }));
      const pick = (want: RetirementPersonView) =>
        classified
          .filter((c) => c.view === want)
          .sort((a, b) => a.p.localeCompare(b.p))
          .map((c) => c.name);
      expect(pick('upcoming'), `upcoming asOf=${asOf}`).toEqual(views.upcoming);
      expect(pick('overdue'), `overdue asOf=${asOf}`).toEqual(views.overdue);
    }
  });

  it('逐日对照：10-12 ~ 10-18 每个 asOf，SQL 行集合 ≡ 纯函数（版本取值手写）', async () => {
    for (let i = 0; i < 7; i += 1) {
      const asOf = addDays('2026-10-12', i);
      const facts = (name: Name) =>
        classifyRetirement({
          asOf,
          upcomingDays: DAYS,
          person: {
            active: true,
            staffId: 'cycle-1',
            cycleEntryDate: HIRE,
            expectedDate: resolveP(SCENARIOS[name], asOf),
          },
          bills: [],
        }).person;
      for (const want of ['upcoming', 'overdue'] as const)
        expect([...(await view(want, asOf))].sort(), `${want} asOf=${asOf}`).toEqual(
          NAMES.filter((name) => facts(name) === want).sort(),
        );
    }
  });
});

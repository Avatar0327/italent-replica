/**
 * BE-13a 第 2 轮返工回归（规格 35“补充：BE-13…”B49 6.04 / 6.08 / 6.11 / 6.13，“员工结构两张报表”B53）：
 * - 审查 P2-3：范围内 21 个机构时，6.04 只取人数前 20 个机构，6.11 不截断（规格只对 6.04 写“取前 20”）；
 * - 审查 P2-1（口径固化，非红测）：司龄 6 个月 / 12 个月、年龄 25 / 30 / 51 岁的“前一天 / 当天 / 后一天”三点，
 *   段名“6 月以下 / 6 月~1 年 / 1~2 年…”“25 岁以下 / 25-30…”都是下限闭区间：恰满 6 个月归入“6 月~1 年”，
 *   差一天归入“6 月以下”；恰满 1 年归入“1~2 年”；恰 25 岁归入“25-30 岁”；恰 51 岁归入“51 岁及以上”。
 * 固定夹具（asOf = 2026-10-01）：21 个机构都直接挂租户根，每个机构一人（即一级组织一行）。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  boardClient,
  ids,
  sorted,
  STRUCTURE_BASE,
  structureWorld,
  type BoardClient,
  type Report,
} from './AC-HA-13a-support.js';

const database = useTestDb();
const B = STRUCTURE_BASE;
const AS_OF = 'asOf=2026-10-01';
/** 司龄夹具的出生日（36 岁，远离年龄边界）与年龄夹具的入职日（满 75 个月，远离司龄边界）。 */
const MID_BIRTHDAY = '1990-06-15';
const MID_ENTRY = '2020-06-15';

/** 名字 → [入职日, 出生日, 有没有本科学历]。 */
const PEOPLE = {
  tenure6Before: ['2026-04-02', MID_BIRTHDAY, true],
  tenure6At: ['2026-04-01', MID_BIRTHDAY, true],
  tenure6After: ['2026-03-31', MID_BIRTHDAY, true],
  tenure12Before: ['2025-10-02', MID_BIRTHDAY, true],
  tenure12At: ['2025-10-01', MID_BIRTHDAY, true],
  tenure12After: ['2025-09-30', MID_BIRTHDAY, true],
  age25Before: [MID_ENTRY, '2001-10-02', false],
  age25At: [MID_ENTRY, '2001-10-01', false],
  age25After: [MID_ENTRY, '2001-09-30', false],
  age30Before: [MID_ENTRY, '1996-10-02', false],
  age30At: [MID_ENTRY, '1996-10-01', false],
  age30After: [MID_ENTRY, '1996-09-30', false],
  age51Before: [MID_ENTRY, '1975-10-02', false],
  age51At: [MID_ENTRY, '1975-10-01', false],
  age51After: [MID_ENTRY, '1975-09-30', false],
  age31At: [MID_ENTRY, '1995-10-01', true],
  filler1: [MID_ENTRY, MID_BIRTHDAY, true],
  filler2: [MID_ENTRY, MID_BIRTHDAY, true],
  filler3: [MID_ENTRY, MID_BIRTHDAY, true],
  filler4: [MID_ENTRY, MID_BIRTHDAY, true],
  filler5: [MID_ENTRY, MID_BIRTHDAY, true],
} as const satisfies Record<string, readonly [string, string, boolean]>;
type Name = keyof typeof PEOPLE;

async function buildWorld() {
  const w = await structureWorld(database().db, 'ha13a-boundaries');
  const people = {} as Record<Name, { id: string }>;
  const institutions = {} as Record<Name, { id: string }>;
  let n = 0;
  for (const [name, [date, birthday, bachelor]] of Object.entries(PEOPLE) as [Name, (typeof PEOPLE)[Name]][]) {
    n += 1;
    const institution = await w.org(`边界机构${String(n).padStart(2, '0')}`, undefined, '机构');
    institutions[name] = institution;
    people[name] = await w.hire(`边界${name}`, {
      date,
      department: institution,
      profile: { gender: '男', birthday, ...(bachelor ? { educationLevel: '本科' } : {}) },
    });
  }
  return { w, people, institutions };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

const NAMES = Object.keys(PEOPLE) as Name[];
const TENURE: Record<string, Name[]> = {
  under6m: ['tenure6Before'],
  '6mto1y': ['tenure6At', 'tenure6After', 'tenure12Before'],
  '1to2y': ['tenure12At', 'tenure12After'],
  '2to5y': [],
  '5to10y': NAMES.filter((name) => !name.startsWith('tenure')),
  '10yplus': [],
};
const AGE: Record<string, Name[]> = {
  under25: ['age25Before'],
  '25to30': ['age25At', 'age25After', 'age30Before', 'age30At', 'age30After'],
  '31to35': ['age31At'],
  '36to40': NAMES.filter((name) => name.startsWith('tenure') || name.startsWith('filler')),
  '41to50': ['age51Before'],
  '51plus': ['age51At', 'age51After'],
};

describe('AC-HA-13a 第 2 轮返工：21 个机构与分段边界', () => {
  let x: World;
  let c: BoardClient;
  const of = (names: readonly Name[]) => ids(...names.map((name) => x.people[name]));
  beforeAll(async () => {
    x = await buildWorld();
    c = boardClient(database().db, x.w.who);
  }, 600_000);

  it('AC-HA-13a-02：范围内 21 个机构——6.04 只列前 20 组，6.11 列全部 21 组；每组数字 = 明细', async () => {
    const all = sorted(NAMES.map((name) => x.institutions[name].id));
    await c.expectCount(B, '6.01', of(NAMES), AS_OF);

    const top = (await c.component(B, '6.04', AS_OF)).groups!;
    expect(top).toHaveLength(20);
    for (const group of top) {
      const name = NAMES.find((item) => x.institutions[item].id === group.key)!;
      expect(name, group.key).toBeDefined();
      await c.expectCount(B, '6.04', of([name]), AS_OF, group.key);
    }

    const ratio = (await c.component(B, '6.11', AS_OF)).groups!;
    expect(sorted(ratio.map((group) => group.key))).toEqual(all);
    for (const name of NAMES) {
      const bachelor = PEOPLE[name][2];
      const key = x.institutions[name].id;
      expect(
        ratio.find((group) => group.key === key),
        name,
      ).toMatchObject({
        count: bachelor ? 1 : 0,
        total: 1,
        ratio: bachelor ? 1 : 0,
      });
      await c.expectCount(B, '6.11', bachelor ? of([name]) : [], AS_OF, key);
    }
  });

  it('AC-HA-13a-03：看板 6.08 / 6.13——司龄 6 / 12 个月、年龄 25 / 30 / 51 岁的前一天 / 当天 / 后一天（口径固化）', async () => {
    for (const [segment, names] of Object.entries(TENURE)) await c.expectCount(B, '6.08', of(names), AS_OF, segment);
    for (const [segment, names] of Object.entries(AGE)) await c.expectCount(B, '6.13', of(names), AS_OF, segment);
  });

  it('AC-HA-13a-05：B53 素质结构报表的司龄段 / 年龄段列与看板同一边界（口径固化）', async () => {
    const report: Report = await c.report('quality', AS_OF);
    expect(report.rows).toHaveLength(21);
    const cells = (name: Name) => report.rows.find((row) => row.organizationId === x.institutions[name].id)!.cells;
    const expected: Record<string, number> = { total: 21 };
    for (const [prefix, segments] of [
      ['tenure', TENURE],
      ['age', AGE],
    ] as const)
      for (const [segment, names] of Object.entries(segments)) {
        expected[`${prefix}:${segment}`] = names.length;
        for (const name of names) expect(cells(name)[`${prefix}:${segment}`], `${name} ${prefix}:${segment}`).toBe(1);
      }
    expect(report.summary.cells).toMatchObject(expected);
  });
});

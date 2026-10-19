/**
 * R2 BE-5c1b（R2-T04 §9.1A，DEC-641，AC-RT-16 纯函数部分；F-262 取证 F262A）：
 * 内置三个法定函数——计算预计退休日期(个人身份)、计算最早提前退休日期(个人身份)、计算最晚延迟退休日期()。
 * 对照表以《关于实施渐进式延迟法定退休年龄的决定》（2024-09-13，2025-01-01 起施行）附件为准：
 * 男职工原 60 岁，1965-01 起每 4 个月延迟 1 个月，最高 63 岁；女干部原 55 岁，1970-01 起每 4 个月延迟 1 个月，最高 58 岁；
 * 女工人原 50 岁，1975-01 起每 2 个月延迟 1 个月，最高 55 岁；改革前出生段不延迟。
 */
import { describe, expect, it } from 'vitest';
import {
  STATUTORY_DELAY_TABLES,
  statutoryEarliestDate,
  statutoryExpectedDate,
  statutoryGroupOf,
  statutoryLatestDate,
  statutoryRetirementAge,
  type StatutoryGroup,
} from '../../packages/domain/src/employment/retirement-statutory.js';

const GROUPS: readonly StatutoryGroup[] = ['male', 'female_cadre', 'female_worker'];

describe('AC-RT-16 法定退休年龄对照表：分组', () => {
  it('男 → male；女 + 工人(10) → female_worker；女 + 干部(20) → female_cadre', () => {
    expect(statutoryGroupOf('male', null)).toBe('male');
    expect(statutoryGroupOf('male', '10')).toBe('male');
    expect(statutoryGroupOf('female', '10')).toBe('female_worker');
    expect(statutoryGroupOf('female', '20')).toBe('female_cadre');
  });

  it('女性个人身份为空或不是工人 / 干部、性别为空或不是 male / female → 无分组（保守不算）', () => {
    expect(statutoryGroupOf('female', null)).toBeNull();
    expect(statutoryGroupOf('female', '99')).toBeNull();
    expect(statutoryGroupOf(null, '10')).toBeNull();
    expect(statutoryGroupOf('other', '10')).toBeNull();
  });
});

describe('AC-RT-16 法定退休年龄对照表：数据表与逐段边界', () => {
  it('行数：改革前 1 段 + 延迟段（男 36、女干部 36、女工人 60）；相邻段首尾相接、延迟月数逐段 +1', () => {
    const expectedRows = { male: 37, female_cadre: 37, female_worker: 61 } as const;
    for (const group of GROUPS) {
      const rows = STATUTORY_DELAY_TABLES[group];
      expect(rows).toHaveLength(expectedRows[group]);
      expect(rows[0]).toMatchObject({ fromBirth: null, delayMonths: 0 });
      rows.forEach((row, index) => expect(row.delayMonths).toBe(index));
      expect(rows.at(-1)!.toBirth).toBeNull();
      for (let index = 1; index < rows.length; index += 1)
        expect(nextMonth(rows[index - 1]!.toBirth!)).toBe(rows[index]!.fromBirth);
    }
  });

  it.each([
    // [分组, 出生年月, 延迟月数]：每一段的首月与末月，加上改革前最后一月与封顶后
    ['male', '1960-01', 0],
    ['male', '1964-12', 0],
    ['male', '1965-01', 1],
    ['male', '1965-04', 1],
    ['male', '1965-05', 2],
    ['male', '1965-08', 2],
    ['male', '1965-09', 3],
    ['male', '1970-12', 24],
    ['male', '1971-01', 25],
    ['male', '1976-05', 34],
    ['male', '1976-08', 35],
    ['male', '1976-09', 36],
    ['male', '1976-12', 36],
    ['male', '1977-01', 36],
    ['male', '2000-06', 36],
    ['female_cadre', '1969-12', 0],
    ['female_cadre', '1970-01', 1],
    ['female_cadre', '1970-04', 1],
    ['female_cadre', '1970-05', 2],
    ['female_cadre', '1981-05', 35],
    ['female_cadre', '1981-08', 35],
    ['female_cadre', '1981-09', 36],
    ['female_cadre', '1981-12', 36],
    ['female_cadre', '1982-01', 36],
    ['female_worker', '1974-12', 0],
    ['female_worker', '1975-01', 1],
    ['female_worker', '1975-02', 1],
    ['female_worker', '1975-03', 2],
    ['female_worker', '1975-04', 2],
    ['female_worker', '1975-05', 3],
    ['female_worker', '1984-09', 58],
    ['female_worker', '1984-10', 59],
    ['female_worker', '1984-11', 60],
    ['female_worker', '1984-12', 60],
    ['female_worker', '1985-01', 60],
  ] as const)('%s 出生 %s → 延迟 %i 个月', (group, birthMonth, delay) => {
    const row = STATUTORY_DELAY_TABLES[group].find(
      (item) => (item.fromBirth === null || item.fromBirth <= birthMonth) && (item.toBirth === null || birthMonth <= item.toBirth),
    );
    expect(row?.delayMonths).toBe(delay);
    const base = { male: 60, female_cadre: 55, female_worker: 50 }[group];
    const total = base * 12 + delay;
    expect(statutoryRetirementAge(group, `${birthMonth}-15`)).toEqual({ years: Math.floor(total / 12), months: total % 12 });
  });

  it('改革后最高年龄：男 63 岁、女干部 58 岁、女工人 55 岁；改革前不变', () => {
    expect(statutoryRetirementAge('male', '1964-12-31')).toEqual({ years: 60, months: 0 });
    expect(statutoryRetirementAge('male', '1976-09-01')).toEqual({ years: 63, months: 0 });
    expect(statutoryRetirementAge('female_cadre', '1981-09-01')).toEqual({ years: 58, months: 0 });
    expect(statutoryRetirementAge('female_worker', '1984-11-01')).toEqual({ years: 55, months: 0 });
    expect(statutoryRetirementAge('female_worker', '1975-01-01')).toEqual({ years: 50, months: 1 });
  });

  it('出生日期为空或不是合法日期 → 空', () => {
    for (const birthday of [null, '', '1970-02-30', 'x', '1970-1-5'])
      expect(statutoryRetirementAge('male', birthday)).toBeNull();
  });
});

describe('AC-RT-16 计算预计退休日期(个人身份)：出生日期 + 改革后退休年龄 + 1 天（DEC-641①）', () => {
  it.each([
    ['male', null, '1964-12-31', '2025-01-01'],
    ['male', null, '1965-01-15', '2025-02-16'],
    ['male', null, '1965-03-31', '2025-05-01'], // 1965-03-31 + 60 岁 1 月 = 2025-04-31 不存在，取月末 04-30，再 +1 天
    ['male', null, '1976-12-31', '2040-01-01'],
    ['male', '20', '1990-06-15', '2053-06-16'],
    ['female', '20', '1970-01-10', '2025-02-11'],
    ['female', '20', '1981-12-31', '2040-01-01'],
    ['female', '10', '1975-02-28', '2025-03-29'],
    ['female', '10', '1975-03-15', '2025-05-16'],
    ['female', '10', '1984-12-31', '2040-01-01'],
    ['female', '10', '1974-12-31', '2025-01-01'],
  ] as const)('%s / 身份 %s / 出生 %s → %s', (gender, identity, birthday, expected) => {
    expect(statutoryExpectedDate(birthday, gender, identity)).toBe(expected);
  });

  it('出生日期、性别为空，或女性个人身份为空 → 空', () => {
    expect(statutoryExpectedDate(null, 'male', null)).toBeNull();
    expect(statutoryExpectedDate('1990-01-01', null, null)).toBeNull();
    expect(statutoryExpectedDate('1990-01-01', 'female', null)).toBeNull();
    expect(statutoryExpectedDate('1990-01-01', 'female', '99')).toBeNull();
  });
});

describe('AC-RT-16 计算最早提前退休日期(个人身份)：出生日期 + 原法定退休年龄 + 1 天（DEC-641②）', () => {
  it.each([
    ['male', null, '1990-06-15', '2053-06-16', '2050-06-16'],
    ['female', '10', '1980-05-20', '2033-02-21', '2030-05-21'],
    ['female', '20', '1980-05-20', '2038-01-21', '2035-05-21'],
    ['male', null, '1960-03-10', '2020-03-11', '2020-03-11'], // 改革前：最早 = 预计
  ] as const)('%s / 身份 %s / 出生 %s / 预计 %s → 最早 %s', (gender, identity, birthday, expected, earliest) => {
    expect(statutoryEarliestDate(birthday, gender, identity, expected)).toBe(earliest);
  });

  it('2 月 29 日出生：原法定退休年龄那年无 2-29 → 取 2-28 再 +1 天（3-01）；有 2-29 → 2-29 再 +1 天', () => {
    expect(statutoryEarliestDate('1968-02-29', 'female', '20', '2030-01-01')).toBe('2023-03-01');
    expect(statutoryEarliestDate('1964-02-29', 'male', null, '2030-01-01')).toBe('2024-03-01');
  });

  it('算出晚于预计退休日期 → 取预计退休日期', () => {
    expect(statutoryEarliestDate('1990-06-15', 'male', null, '2049-01-01')).toBe('2049-01-01');
    expect(statutoryEarliestDate('1990-06-15', 'male', null, '2050-06-16')).toBe('2050-06-16');
    expect(statutoryEarliestDate('1990-06-15', 'male', null, '2050-06-17')).toBe('2050-06-16');
  });

  it('预计退休日期为空 → 空；出生日期、性别为空 → 空；女性个人身份为空 → 空（不限制）', () => {
    expect(statutoryEarliestDate('1990-06-15', 'male', null, null)).toBeNull();
    expect(statutoryEarliestDate(null, 'male', null, '2053-06-16')).toBeNull();
    expect(statutoryEarliestDate('1990-06-15', null, null, '2053-06-16')).toBeNull();
    expect(statutoryEarliestDate('1990-06-15', 'female', null, '2053-06-16')).toBeNull();
    expect(statutoryEarliestDate('1990-06-15', 'female', '99', '2053-06-16')).toBeNull();
  });
});

describe('AC-RT-16 计算最晚延迟退休日期()：预计退休日期 + 3 年（同月同日，DEC-641③）', () => {
  it.each([
    ['2030-06-01', '2033-06-01'],
    ['2030-12-31', '2033-12-31'],
    ['2028-02-29', '2031-02-28'], // 无对应日取 2 月 28 日
    ['2024-02-29', '2027-02-28'],
    ['2029-02-28', '2032-02-28'], // 2-28 仍是 2-28，不顺延到闰年 2-29
    ['2025-03-01', '2028-03-01'],
  ])('预计 %s → 最晚 %s', (expected, latest) => {
    expect(statutoryLatestDate(expected)).toBe(latest);
  });

  it('预计退休日期为空或不是合法日期 → 空', () => {
    expect(statutoryLatestDate(null)).toBeNull();
    expect(statutoryLatestDate('')).toBeNull();
    expect(statutoryLatestDate('2030-02-30')).toBeNull();
  });
});

function nextMonth(value: string): string {
  const [year, month] = value.split('-').map(Number) as [number, number];
  const total = year * 12 + month;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

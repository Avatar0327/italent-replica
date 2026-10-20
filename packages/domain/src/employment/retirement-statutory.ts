/**
 * R2-T04 §9.1A 内置法定函数（纯函数，禁止 IO；DEC-641，F-262 取证 F262A）。
 * 对照表来源：《全国人民代表大会常务委员会关于实施渐进式延迟法定退休年龄的决定》（2024-09-13，2025-01-01 起施行）附件：
 * 男职工原 60 岁、1965-01 起每 4 个月延迟 1 个月，最高 63 岁；女职工原 55 岁（干部）1970-01 起每 4 个月延迟 1 个月，
 * 最高 58 岁；女职工原 50 岁（工人）1975-01 起每 2 个月延迟 1 个月，最高 55 岁；起点之前出生的不延迟。
 */
export const STATUTORY_FUNCTIONS = {
  expectedDate: 'statutory_expected_date',
  earliest: 'statutory_earliest',
  latest: 'statutory_latest',
} as const;
/** 规则里“选用内置函数”的展示名（DEC-641①）。 */
export const STATUTORY_FUNCTION_LABELS: Readonly<Record<string, string>> = {
  statutory_expected_date: '计算预计退休日期(个人身份)',
  statutory_earliest: '计算最早提前退休日期(个人身份)',
  statutory_latest: '计算最晚延迟退休日期()',
};
/** 最晚延迟退休日期 = 预计退休日期 + 3 年（DEC-641③）。 */
export const STATUTORY_LATEST_YEARS = 3;

export type StatutoryGroup = 'male' | 'female_cadre' | 'female_worker';

/** 渐进延迟规则：数据表驱动，下面展开成逐段对照表；改动只改这里。 */
const DELAY_RULES: Readonly<
  Record<
    StatutoryGroup,
    {
      readonly originalAgeYears: number;
      /** 第一个延迟 1 个月的出生年月 */
      readonly firstBirth: readonly [number, number];
      /** 每多少个出生月多延迟 1 个月 */
      readonly birthMonthsPerDelay: number;
      /** 延迟月数上限（到达最高法定年龄） */
      readonly maxDelayMonths: number;
    }
  >
> = {
  male: { originalAgeYears: 60, firstBirth: [1965, 1], birthMonthsPerDelay: 4, maxDelayMonths: 36 },
  female_cadre: { originalAgeYears: 55, firstBirth: [1970, 1], birthMonthsPerDelay: 4, maxDelayMonths: 36 },
  female_worker: { originalAgeYears: 50, firstBirth: [1975, 1], birthMonthsPerDelay: 2, maxDelayMonths: 60 },
};

/** 一段出生年月（含两端，YYYY-MM；null = 无界）对应的延迟月数。 */
export interface StatutorySegment {
  readonly fromBirth: string | null;
  readonly toBirth: string | null;
  readonly delayMonths: number;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');
const monthKey = (index: number) => `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;

function buildTable(group: StatutoryGroup): readonly StatutorySegment[] {
  const { firstBirth, birthMonthsPerDelay, maxDelayMonths } = DELAY_RULES[group];
  const first = firstBirth[0] * 12 + (firstBirth[1] - 1);
  const rows: StatutorySegment[] = [{ fromBirth: null, toBirth: monthKey(first - 1), delayMonths: 0 }];
  for (let delay = 1; delay <= maxDelayMonths; delay += 1) {
    const from = first + (delay - 1) * birthMonthsPerDelay;
    rows.push({
      fromBirth: monthKey(from),
      toBirth: delay === maxDelayMonths ? null : monthKey(from + birthMonthsPerDelay - 1),
      delayMonths: delay,
    });
  }
  return rows;
}

export const STATUTORY_DELAY_TABLES: Readonly<Record<StatutoryGroup, readonly StatutorySegment[]>> = {
  male: buildTable('male'),
  female_cadre: buildTable('female_cadre'),
  female_worker: buildTable('female_worker'),
};

/** 个人身份字典标准项编码（DEC-640③）；字典预置值 RETIREMENT_IDENTITY_TYPE_PRESETS 引用这里，避免两处各写一份。 */
export const IDENTITY_TYPE_WORKER = '10';
export const IDENTITY_TYPE_CADRE = '20';

/** 男 → male；女 + 工人 → female_worker；女 + 干部 → female_cadre；其余（性别空、女性身份空或非标准）→ 无法判定。 */
export function statutoryGroupOf(gender: string | null, identityType: string | null): StatutoryGroup | null {
  if (gender === 'male') return 'male';
  if (gender !== 'female') return null;
  if (identityType === IDENTITY_TYPE_WORKER) return 'female_worker';
  if (identityType === IDENTITY_TYPE_CADRE) return 'female_cadre';
  return null;
}

interface YmdParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function parseYmd(value: string | null): YmdParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day ? { year, month, day } : null;
}

function format(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 加月数，日超出目标月月末时取月末（2-29 → 平年 2-28、03-31 + 1 月 → 04-30）。 */
function addMonths(parts: YmdParts, months: number): Date {
  const total = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(parts.day, lastDay)));
}

const nextDay = (date: Date): Date => new Date(date.getTime() + 24 * 3600 * 1000);

/** 改革后法定退休年龄（年 + 月）：按出生年月查对照表；出生日期为空或不合法 → 空。 */
export function statutoryRetirementAge(
  group: StatutoryGroup,
  birthday: string | null,
): { readonly years: number; readonly months: number } | null {
  const birth = parseYmd(birthday);
  if (!birth) return null;
  const birthMonth = `${pad(birth.year, 4)}-${pad(birth.month)}`;
  const segment = STATUTORY_DELAY_TABLES[group].find(
    (row) =>
      (row.fromBirth === null || row.fromBirth <= birthMonth) && (row.toBirth === null || birthMonth <= row.toBirth),
  );
  if (!segment) return null;
  const total = DELAY_RULES[group].originalAgeYears * 12 + segment.delayMonths;
  return { years: Math.floor(total / 12), months: total % 12 };
}

/** 计算预计退休日期(个人身份)：出生日期 + 改革后法定退休年龄 + 1 天（正式退休开始日，DEC-641①）。 */
export function statutoryExpectedDate(
  birthday: string | null,
  gender: string | null,
  identityType: string | null,
): string | null {
  const group = statutoryGroupOf(gender, identityType);
  const birth = parseYmd(birthday);
  const age = group && statutoryRetirementAge(group, birthday);
  if (!birth || !age) return null;
  return format(nextDay(addMonths(birth, age.years * 12 + age.months)));
}

/**
 * 计算最早提前退休日期(个人身份)：出生日期 + 原法定退休年龄（男 60、女干部 55、女工人 50）+ 1 天；
 * 晚于预计退休日期则取预计退休日期；预计退休日期为空 → 空（DEC-641④）；女性个人身份为空 → 空（不限制）。
 */
export function statutoryEarliestDate(
  birthday: string | null,
  gender: string | null,
  identityType: string | null,
  expectedDate: string | null,
): string | null {
  const group = statutoryGroupOf(gender, identityType);
  const birth = parseYmd(birthday);
  if (!group || !birth || !parseYmd(expectedDate)) return null;
  const earliest = format(nextDay(addMonths(birth, DELAY_RULES[group].originalAgeYears * 12)));
  return earliest > expectedDate! ? expectedDate : earliest;
}

/** 计算最晚延迟退休日期()：预计退休日期 + 3 年（同月同日，2-29 无对应日取 2-28）；预计退休日期为空 → 空。 */
export function statutoryLatestDate(expectedDate: string | null): string | null {
  const parts = parseYmd(expectedDate);
  return parts ? format(addMonths(parts, STATUTORY_LATEST_YEARS * 12)) : null;
}

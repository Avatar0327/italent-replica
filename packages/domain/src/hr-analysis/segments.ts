/**
 * 人事分析的分段规则（docs/02_业务建模/35“员工结构两张报表”、B49 6.08 / 6.12～6.14）：年龄 6 段、司龄 6 段、学历四档、性别。
 * 看板（B49 / B50）与报表（B53 / B54）共用同一套边界，流动（BE-13b）也从这里取，不另写第二份。
 * 空值单独成段（键 SEGMENT_NONE）：原站图表把空值列为一项，报表列只展开有名字的段。
 */
import { ageOn } from '../personnel/tenure.js';
import { tenureYears } from './roster.js';

export const SEGMENT_NONE = 'none';

/** 年龄段（整岁，ageOn 口径）：段的下界含、上界含；恰 25 岁归入“25-30 岁”，差一天归入“25 岁以下”；恰 51 岁归入“51 岁及以上”。 */
export const AGE_SEGMENTS = [
  { key: 'under25', label: '25岁以下', max: 24 },
  { key: '25to30', label: '25-30岁', max: 30 },
  { key: '31to35', label: '31-35岁', max: 35 },
  { key: '36to40', label: '36-40岁', max: 40 },
  { key: '41to50', label: '41-50岁', max: 50 },
  { key: '51plus', label: '51岁及以上', max: Infinity },
] as const;

/**
 * 司龄段（按入职日到 asOf 的整日历月，段名下限闭区间）：恰满 6 个月归入“6 月~1 年”，差一天归入“6 月以下”；
 * 恰满 12 个月归入“1~2 年”，差一天归入“6 月~1 年”。
 */
export const TENURE_SEGMENTS = [
  { key: 'under6m', label: '6月以下', max: 5 },
  { key: '6mto1y', label: '6月~1年', max: 11 },
  { key: '1to2y', label: '1~2年', max: 23 },
  { key: '2to5y', label: '2~5年', max: 59 },
  { key: '5to10y', label: '5~10年', max: 119 },
  { key: '10yplus', label: '10年及以上', max: Infinity },
] as const;

/** 学历四档（最高学历是自由文本，没有租户字典）：按关键字归档，非空但认不出的归“大专及以下”。 */
export const EDUCATION_TIERS = [
  { key: 'doctor', label: '博士', words: ['博士'] },
  { key: 'master', label: '硕士', words: ['硕士', '研究生'] },
  { key: 'bachelor', label: '本科', words: ['本科', '学士'] },
  { key: 'collegeOrBelow', label: '大专及以下', words: [] },
] as const;
/** 6.11“本科及以上”所含的学历档。 */
export const BACHELOR_OR_ABOVE: readonly string[] = ['doctor', 'master', 'bachelor'];

/** 性别：男 / 女 / 保密三项固定，其余非空原值单独成段（原站选项是租户字典，复刻仓库没有字典，存的是文本）。 */
export const GENDER_SEGMENTS = [
  { key: '男', label: '男' },
  { key: '女', label: '女' },
  { key: '保密', label: '保密' },
] as const;
const GENDER_ALIASES: Readonly<Record<string, string>> = { male: '男', female: '女', m: '男', f: '女' };

const blank = (value: string | null | undefined): value is null | undefined | '' => !value || !value.trim();

/** 整日历月数：asOf 的日小于起算日的日时，当月不算满。 */
export function wholeMonths(from: string, asOf: string): number {
  const months =
    (Number(asOf.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(asOf.slice(5, 7)) - Number(from.slice(5, 7));
  return months - (asOf.slice(8) < from.slice(8) ? 1 : 0);
}

export function ageSegment(birthday: string | null, asOf: string): string {
  const age = ageOn(birthday, asOf);
  return age === null ? SEGMENT_NONE : AGE_SEGMENTS.find((segment) => age <= segment.max)!.key;
}

export function tenureSegment(entryDate: string | null, asOf: string): string {
  if (!entryDate || entryDate > asOf) return SEGMENT_NONE;
  const months = wholeMonths(entryDate, asOf);
  return TENURE_SEGMENTS.find((segment) => months <= segment.max)!.key;
}

export function educationTier(level: string | null): string {
  if (blank(level)) return SEGMENT_NONE;
  const tier = EDUCATION_TIERS.find((item) => item.words.some((word) => level.includes(word)));
  return tier?.key ?? 'collegeOrBelow';
}

export function genderSegment(gender: string | null): string {
  if (blank(gender)) return SEGMENT_NONE;
  const value = gender.trim();
  return GENDER_ALIASES[value.toLowerCase()] ?? value;
}

/** 平均值保留 1 位小数（四舍五入）；没有样本为 null（不是 0）。 */
export function segmentAverage(values: readonly number[]): number | null {
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

/** 平均年龄 / 平均司龄的样本：年龄取整岁，司龄取 tenureYears（365 天一年）；空值不进样本。 */
export const ageSample = (birthday: string | null, asOf: string) => ageOn(birthday, asOf);
export function tenureSample(entryDate: string | null, asOf: string): number | null {
  const years = tenureYears(entryDate, asOf);
  return years === null ? null : Number(years);
}

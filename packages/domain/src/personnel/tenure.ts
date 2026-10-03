/** 17 附录 G-041：当前 StaffID 中与当前值相同的历史区间加总，365 天一年，向下舍位。 */
export interface TenureInterval {
  readonly staffId: string;
  readonly startDate: string;
  /** Exclusive interval end; leave/retirement use last working day + 1. */
  readonly stopDate: string | null;
  readonly postId: string | null;
  readonly levelId: string | null;
  readonly positionId: string | null;
}
const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
export function decimalYears(days: number, precision: number): string {
  const scale = 10 ** precision;
  return (Math.floor((days * scale) / 365) / scale).toFixed(precision);
}
export function computeTenure(intervals: readonly TenureInterval[], asOf: string) {
  const available = intervals
    .filter((row) => row.startDate <= asOf)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const current = available.at(-1);
  const result: Record<string, string | null> = {};
  for (const [field, label] of [
    ['postId', 'JobPost'],
    ['levelId', 'JobLevel'],
    ['positionId', 'Position'],
  ] as const) {
    const value = current?.[field];
    const days = value
      ? available
          .filter((row) => row.staffId === current.staffId && row[field] === value)
          .reduce(
            (sum, row) =>
              sum + Math.max(0, day(row.stopDate && row.stopDate < asOf ? row.stopDate : asOf) - day(row.startDate)),
            0,
          )
      : null;
    result[`current${label}InYears`] = days === null ? null : decimalYears(days, 1);
    result[`accumulate${label}InYears`] = days === null ? null : decimalYears(days, 4);
  }
  // TODO(需取证 Q-M0-35)：干部模块暂停，现有任职链没有干部任期来源，不把关键人员等同干部。
  result.currentCadreServiceYears = null;
  result.accumulateCadreServiceInYears = null;
  return result;
}
export function ageOn(birthday: string | null, asOf: string): number | null {
  if (!birthday || birthday > asOf) return null;
  return Number(asOf.slice(0, 4)) - Number(birthday.slice(0, 4)) - (asOf.slice(5) < birthday.slice(5) ? 1 : 0);
}

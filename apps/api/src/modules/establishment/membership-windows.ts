/** 组织改挂会改变含下级人数；每段按当段行政树裁剪占编，不把目标日的子树冻结到周期末。 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { subtreeIds } from './org-reader.js';
import { rowsOf } from './store.js';
export interface MembershipWindow {
  readonly from: string;
  readonly until: string;
  readonly orgIds: readonly string[];
}
export async function membershipWindows(
  tx: Tx,
  tenantId: string,
  orgId: string,
  from: string,
  end: string,
  excluded: readonly string[],
): Promise<MembershipWindow[]> {
  const changes = rowsOf<{ date: string }>(
    await tx.execute(sql`SELECT DISTINCT start_date::text AS date
    FROM org_versions WHERE tenant_id=${tenantId} AND start_date>${from}::date AND start_date<=${end}::date
    ORDER BY date LIMIT 1001`),
  );
  if (changes.length > 1000) throw new AppError('SERVICE_UNAVAILABLE', '编制周期组织变化超过处理上限');
  const dates = [from, ...changes.map((c) => c.date), new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10)];
  const windows: MembershipWindow[] = [];
  for (let i = 0; i < dates.length - 1; i++) {
    const orgIds = (await subtreeIds(tx, tenantId, orgId, dates[i]!)).filter((id) => !excluded.includes(id));
    const previous = windows.at(-1);
    if (previous && previous.orgIds.join(',') === orgIds.join(',')) {
      windows[windows.length - 1] = { ...previous, until: dates[i + 1]! };
    } else windows.push({ from: dates[i]!, until: dates[i + 1]!, orgIds });
  }
  return windows;
}
export function clipMembership<T extends { fields: { departmentId?: string | null }; from: string; until: string }>(
  intervals: readonly T[],
  windows: readonly MembershipWindow[],
): T[] {
  return intervals.flatMap((interval) =>
    windows.flatMap((window) => {
      if (!window.orgIds.includes(interval.fields.departmentId ?? '')) return [];
      const from = interval.from > window.from ? interval.from : window.from;
      const until = interval.until < window.until ? interval.until : window.until;
      return from < until ? [{ ...interval, from, until }] : [];
    }),
  );
}

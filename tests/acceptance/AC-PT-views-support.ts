/**
 * BE-7 PT-5 六视图 / 详情期限链的共用夹具（docs/08_设计/R2-T05_兼职设计.md §6.1 / §6.2 / §6.3，§13.3）：
 * 以 HTTP_TODAY（2026-10-01）为“租户今天”可信造一组覆盖全部边界的兼职记录（结束日 = 今天 / 昨天 / 第 30 天 / 第 31 天、
 * 明天开始、空区间、当天开始当天结束、无结束日期）和审批中 / 非审批中的申请，逐条断言六视图归属与 total。
 */
import type { Authorizer } from '@italent/api';
import { withTenant } from '@italent/db';
import { HTTP_TODAY, httpWorld, type HttpWorld, type PartTimeBody } from './AC-PT-http-support.js';

type Db = Parameters<typeof httpWorld>[0];

/** 六视图夹具里每条记录的开始 / 结束日期（相对 HTTP_TODAY = 2026-10-01）。 */
export const MATRIX = {
  /** 无结束日期：进兼职中，不进即将到期。 */
  open: ['2026-09-01', null],
  /** 结束日 = 今天：仍是兼职中，进即将到期。 */
  endsToday: ['2026-09-01', '2026-10-01'],
  /** 结束日 = 今天 + 30：含第 30 天（B-1 取含）。 */
  endsDay30: ['2026-09-01', '2026-10-31'],
  /** 结束日 = 今天 + 31：兼职中，不进默认即将到期。 */
  endsDay31: ['2026-09-01', '2026-11-01'],
  /** 结束日 = 昨天：已结束。 */
  endedYesterday: ['2026-09-01', '2026-09-30'],
  /** 明天开始：未开始，任职状态仍是任职中。 */
  startsTomorrow: ['2026-10-02', '2026-12-31'],
  /** 空区间（end = start − 1，离职联动写出）：已结束，不是未开始。 */
  emptySpan: ['2026-10-05', '2026-10-04'],
  /** 当天开始当天结束（W-613）：兼职中，也计入即将到期。 */
  sameDay: ['2026-10-01', '2026-10-01'],
  /** 今天开始、无结束日期：兼职中。 */
  startsToday: ['2026-10-01', null],
} as const satisfies Record<string, readonly [string, string | null]>;
export type MatrixKey = keyof typeof MATRIX;

/** 每个视图应有的记录（夹具里按名字）。 */
export const MATRIX_VIEWS: Record<'ongoing' | 'expiring' | 'not_started' | 'ended' | 'all', readonly MatrixKey[]> = {
  ongoing: ['open', 'endsToday', 'endsDay30', 'endsDay31', 'sameDay', 'startsToday'],
  expiring: ['endsToday', 'endsDay30', 'sameDay'],
  not_started: ['startsTomorrow'],
  ended: ['endedYesterday', 'emptySpan'],
  all: Object.keys(MATRIX) as MatrixKey[],
};

/** 视图行：记录视图沿用兼职记录读形状，in_approval 行另带申请字段；主职部门只在主职记录可见时给出。 */
export interface ViewItem extends PartTimeBody {
  effectiveDate: string;
  employee: { code: string; name: string };
  primaryDepartmentId?: string;
  kind?: string;
  status?: string;
  initiator?: string;
  initiatorUserId?: string;
  createdAt?: string;
  recordId?: string | null;
  originalEndDate?: string | null;
}

export interface ViewBody {
  items: ViewItem[];
  total: number;
  page: number;
  pageSize: number;
  hasDataPermission: boolean;
}

export async function viewsWorld(db: Db, label: string) {
  const w = await httpWorld(db, label);
  /** 经受限授权器（默认看全部）发 GET，day 缺省为夹具的今天。 */
  const get = (path: string) => w.request('GET', path);
  /** 同一租户 / 用户换授权器的 GET（受限操作人）。 */
  const getAs = (authorize: Authorizer) => (path: string) => w.as(authorize)('GET', path);
  const view = async (name: string, query = '', send: (path: string) => Promise<Response> = get) =>
    w.ok<ViewBody>(await send(`/part-times?view=${name}${query}`));
  const idsOf = (body: ViewBody) => body.items.map((item) => item.id);

  /** 造出 MATRIX 的全部记录，返回 名字 → 记录 ID。空区间用第 2 期 exit 来源写出。 */
  async function seedMatrix(): Promise<Record<MatrixKey, string>> {
    const ids = {} as Record<MatrixKey, string>;
    for (const [key, [startDate, endDate]] of Object.entries(MATRIX) as [
      MatrixKey,
      readonly [string, string | null],
    ][]) {
      const empty = key === 'emptySpan';
      ids[key] = await w.seedPartTime({ startDate, endDate: empty ? null : endDate });
      if (empty) await withTenant(w.db, w.tenantId, (tx) => tx.execute(w.term(ids[key], 2, endDate, 'exit')));
    }
    return ids;
  }
  const keysOf = (ids: Record<MatrixKey, string>, found: readonly string[]) =>
    (Object.keys(ids) as MatrixKey[]).filter((key) => found.includes(ids[key]));

  return { ...w, get, getAs, view, idsOf, seedMatrix, keysOf, today: HTTP_TODAY };
}

export type ViewsWorld = HttpWorld & Awaited<ReturnType<typeof viewsWorld>>;

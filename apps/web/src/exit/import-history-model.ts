/** F-493 §9.5 导入历史：请求路径与读取结果校验。形状对照 apps/api/src/modules/employment/exit-import-history.ts。 */
import { importPath } from './exit-import-model.js';

export const HISTORY_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];
export type HistoryFilters = { status: HistoryStatus[]; from?: string; to?: string };
export type HistoryItem = {
  id: string;
  createdAt: string;
  submitterName: string;
  status: HistoryStatus;
  total: number;
  errorCount: number | null;
  hasErrorFile: boolean;
  fileName: string;
  filesExpired: boolean;
};
export type HistoryPage = { items: HistoryItem[]; page: number; hasNext: boolean };

/** 状态按固定顺序拼接（后端逗号分隔）；日期为租户业务日期，原样交后端。 */
export function historyPath(page: number, filters: HistoryFilters): string {
  const query = new URLSearchParams({ page: String(page) });
  const status = HISTORY_STATUSES.filter((value) => filters.status.includes(value));
  if (status.length) query.set('status', status.join(','));
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  return `${importPath}/batches?${query.toString()}`;
}

const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function itemOf(value: unknown): HistoryItem | undefined {
  const row = value as Record<string, unknown> | null;
  if (typeof row !== 'object' || row === null) return undefined;
  const valid =
    typeof row.id === 'string' &&
    row.importType === 'exit' &&
    typeof row.createdAt === 'string' &&
    !Number.isNaN(Date.parse(row.createdAt)) &&
    typeof row.submitterName === 'string' &&
    HISTORY_STATUSES.includes(row.status as HistoryStatus) &&
    count(row.total) &&
    (row.status === 'running' ? row.errorCount === null : count(row.errorCount)) &&
    typeof row.hasErrorFile === 'boolean' &&
    typeof row.fileName === 'string' &&
    typeof row.filesExpired === 'boolean';
  return valid ? (row as HistoryItem) : undefined;
}

/** 任一行不合契约即整页判无效，不渲染半截表格。 */
export function parseHistory(value: unknown): HistoryPage | undefined {
  const body = value as { items?: unknown; page?: unknown; hasNext?: unknown } | null;
  if (!body || !Array.isArray(body.items) || !count(body.page) || typeof body.hasNext !== 'boolean') return undefined;
  const items = body.items.map(itemOf);
  return items.every(Boolean)
    ? { items: items as HistoryItem[], page: body.page as number, hasNext: body.hasNext }
    : undefined;
}

/** 导入时间按租户时区显示到分钟（DEC-056），同消息中心的写法。 */
export const tenantMinute = (instant: string, timeZone: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));

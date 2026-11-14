import type { JobGraphLayout, JobGraphReason } from '@italent/domain';

/** 授权对象与路由（apps/api/src/modules/job/graph-routes.ts，设计 §4.2 / §4.3）。 */
export const GRAPH_OBJECT = 'TenantBase.JobPostAndJobLevelGraph';
export const GRAPH_PATH = '/api/tenant/job/graph';
/** 图谱每租户只有一份快照（DEC-896 U3）：命令内核的业务 ID 固定，回执与重读据此核对。 */
export const GRAPH_ID = 'job-graph';
export const graphViews = ['graph', 'graph-issues'] as const;
/** 待确认记录页与图谱同一路由，按 kind 区分（设计 §5：警示链接、弹框“去查看”新窗口打开）。 */
export const ISSUES_SEARCH = '?kind=graph-issues';

export interface GraphSnapshot {
  revision: number;
  asOfDate: string;
  empty: boolean;
  containsError: boolean;
  issueCount: number;
  generatedAt: string;
  layout: JobGraphLayout;
}
export interface GraphIssue {
  kind: 'level' | 'post';
  objectId: string;
  objectName: string;
  reasons: JobGraphReason[];
}
export interface GraphIssuePage {
  items: GraphIssue[];
  total: number;
  page: number;
  pageSize: number;
}

/** 生成时间按租户时区显示 yyyy-MM-dd HH:mm:ss（DEC-056），不用浏览器时区。 */
export function graphTime(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

/** 原因文案与表头与导出共用一份（packages/domain/src/job/graph-text.ts）。 */
export {
  jobGraphGrid as graphGrid,
  jobGraphReasonText as reasonText,
  type JobGraphGridCell as GridCell,
} from '@italent/domain';

/** 待确认记录每页条数：接口 pageSize 上限 100（graph-routes.ts issueQuery），默认 15（设计 §5）。 */
export const ISSUE_PAGE_SIZES = [15, 20, 50, 100] as const;

export function issueQuery(page: { page: number; pageSize: number }, kind: string, name: string) {
  const query = new URLSearchParams({ page: String(page.page), pageSize: String(page.pageSize) });
  if (kind) query.set('kind', kind);
  if (name.trim()) query.set('name', name.trim());
  return query.toString();
}

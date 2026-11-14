import { App, Button } from 'antd';
import { useEffect, useState } from 'react';
import { ListPage, tenantDate, useSession, type ListView } from '../foundation/index.js';
import { useRemote, type PageAccess } from '../org/page-support.js';
import { JobEditor } from './JobEditor.js';
import {
  GRAPH_PATH,
  ISSUE_PAGE_SIZES,
  issueQuery,
  reasonText,
  type GraphIssue,
  type GraphIssuePage,
} from './graph-model.js';
import { GraphIssueFilters, type IssueFilters } from './GraphIssueFilters.js';
import type { JobKind, JobRow } from './page-model.js';
import { graphText as t, pageText as m } from './messages.js';

const sources: Record<GraphIssue['kind'], JobKind> = { level: 'levels', post: 'posts' };

/**
 * 待确认的职务职级记录（设计 §5、DEC-896）：读生成时落下的不规范记录，原因按机器码现拼；
 * “编辑”按源对象（职级 / 职务）的编辑权显示，打开职务体系同一个编辑弹窗。
 */
export function JobGraphIssues({ view, accessOf }: { view: ListView; accessOf: (kind: JobKind) => PageAccess }) {
  const session = useSession();
  const [page, setPage] = useState<{ page: number; pageSize: number }>({ page: 1, pageSize: ISSUE_PAGE_SIZES[0] });
  const [filters, setFilters] = useState<IssueFilters>({ kind: '', name: '' });
  const remote = useRemote<GraphIssuePage>(`${GRAPH_PATH}/issues?${issueQuery(page, filters.kind, filters.name)}`);
  const editing = useEditTarget();
  const columns = issueColumns(accessOf, (issue) => editing.open(issue, tenantDate(new Date(), session.timezone)));
  return (
    <>
      <ListPage<GraphIssue>
        title={t.issuesTitle}
        view={view}
        rowKey={(issue) => `${issue.kind}:${issue.objectId}`}
        page={page}
        onPageChange={setPage}
        pageSizes={ISSUE_PAGE_SIZES}
        data={remote.data ?? { items: [] }}
        loading={remote.loading}
        error={remote.error}
        retry={remote.refresh}
        filters={
          <GraphIssueFilters
            value={filters}
            onApply={(next) => {
              setFilters(next);
              setPage({ ...page, page: 1 });
            }}
          />
        }
        columns={columns}
      />
      {editing.editor && (
        <JobEditor
          kind={editing.editor.kind}
          original={editing.editor.original}
          date={editing.editor.today}
          today={editing.editor.today}
          access={accessOf(editing.editor.kind)}
          onClose={editing.close}
          onSaved={editing.saved}
        />
      )}
    </>
  );
}

/**
 * 编辑读取只认最近一次点击：读取走 useRemote，换目标、关闭、卸载都会让旧请求失效，
 * 迟到的响应不会替换正在填写的表单。
 */
function useEditTarget() {
  const { message } = App.useApp();
  const [target, setTarget] = useState<{ kind: JobKind; id: string; today: string }>();
  const remote = useRemote<JobRow>(
    target ? `/api/tenant/job/${target.kind}/${encodeURIComponent(target.id)}?asOf=${target.today}` : null,
  );
  useEffect(() => {
    if (!remote.error) return;
    void message.error(t.editFailed);
    setTarget(undefined);
  }, [remote.error, message]);
  return {
    editor: target && remote.data ? { kind: target.kind, original: remote.data, today: target.today } : undefined,
    open: (issue: GraphIssue, today: string) => {
      setTarget({ kind: sources[issue.kind], id: issue.objectId, today });
      // 每次点击都重新读取：同一条记录保存后再开，不沿用上次读到的旧版本。
      remote.refresh();
    },
    close: () => setTarget(undefined),
    saved: () => void message.success(m.saved),
  };
}

function issueColumns(accessOf: (kind: JobKind) => PageAccess, open: (issue: GraphIssue) => void) {
  return [
    { key: 'kind', title: t.kind, dataIndex: 'kind', width: 100, render: (value: string) => t.kinds[value] ?? value },
    { key: 'name', title: t.name, dataIndex: 'objectName', width: 200 },
    {
      key: 'reason',
      title: t.reason,
      dataIndex: 'reasons',
      render: (reasons: GraphIssue['reasons']) => reasonText(reasons),
    },
    {
      key: 'actions',
      title: m.operation,
      width: 100,
      render: (_: unknown, issue: GraphIssue) =>
        accessOf(sources[issue.kind]).can('update') && (
          <Button type="link" onClick={() => open(issue)}>
            {m.edit}
          </Button>
        ),
    },
  ];
}

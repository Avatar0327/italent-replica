import { App, Button, Input, Select, Space } from 'antd';
import { useState } from 'react';
import { ListPage, tenantDate, useApiClient, useSession, type ListView } from '../foundation/index.js';
import { useRemote, type PageAccess } from '../org/page-support.js';
import { JobEditor } from './JobEditor.js';
import { GRAPH_PATH, issueQuery, reasonText, type GraphIssue, type GraphIssuePage } from './graph-model.js';
import type { JobKind, JobRow } from './page-model.js';
import { graphText as t, pageText as m } from './messages.js';

const sources: Record<GraphIssue['kind'], JobKind> = { level: 'levels', post: 'posts' };

/**
 * 待确认的职务职级记录（设计 §5、DEC-896）：读生成时落下的不规范记录，原因按机器码现拼；
 * “编辑”按源对象（职级 / 职务）的编辑权显示，打开职务体系同一个编辑弹窗。
 */
export function JobGraphIssues({ view, accessOf }: { view: ListView; accessOf: (kind: JobKind) => PageAccess }) {
  const api = useApiClient();
  const session = useSession();
  const { message } = App.useApp();
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [kind, setKind] = useState('');
  const [name, setName] = useState('');
  const [editor, setEditor] = useState<{ kind: JobKind; original: JobRow; today: string }>();
  const remote = useRemote<GraphIssuePage>(`${GRAPH_PATH}/issues?${issueQuery(page, kind, name)}`);
  const open = async (issue: GraphIssue) => {
    const source = sources[issue.kind];
    const today = tenantDate(new Date(), session.timezone);
    try {
      const original = await api.request<JobRow>(
        `/api/tenant/job/${source}/${encodeURIComponent(issue.objectId)}?asOf=${today}`,
      );
      setEditor({ kind: source, original, today });
    } catch {
      void message.error(t.editFailed);
    }
  };
  const columns = issueColumns(accessOf, (issue) => void open(issue));
  const filter = (apply: () => void) => {
    apply();
    setPage({ ...page, page: 1 });
  };
  return (
    <>
      <ListPage<GraphIssue>
        title={t.issuesTitle}
        view={view}
        rowKey={(issue) => `${issue.kind}:${issue.objectId}`}
        page={page}
        onPageChange={setPage}
        data={remote.data ?? { items: [] }}
        loading={remote.loading}
        error={remote.error}
        retry={remote.refresh}
        filters={
          <Space wrap>
            <Select
              aria-label={t.kind}
              value={kind}
              onChange={(value) => filter(() => setKind(value))}
              options={[
                { value: '', label: t.allKinds },
                { value: 'level', label: t.kinds.level },
                { value: 'post', label: t.kinds.post },
              ]}
            />
            <Input.Search
              aria-label={t.name}
              placeholder={t.name}
              allowClear
              onSearch={(value) => filter(() => setName(value))}
            />
          </Space>
        }
        columns={columns}
      />
      {editor && (
        <JobEditor
          kind={editor.kind}
          original={editor.original}
          date={editor.today}
          today={editor.today}
          access={accessOf(editor.kind)}
          onClose={() => setEditor(undefined)}
          onSaved={() => void message.success(m.saved)}
        />
      )}
    </>
  );
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

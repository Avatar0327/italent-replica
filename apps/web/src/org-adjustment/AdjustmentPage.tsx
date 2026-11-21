import { Button, Select, Space, type TableColumnsType } from 'antd';
import { labels, text } from './messages.js';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { formatInstant } from '../approval/ApprovalDetail.js';
import { ApiError, type PageRequest, type PageResult } from '../foundation/client.js';
import { useSession } from '../foundation/Session.js';
import { PageState } from '../foundation/PageState.js';
import { ListPage } from '../foundation/templates.js';
import { useRemote } from '../org/page-support.js';
import { ApplicationForm } from './ApplicationForm.js';
import { useAdjustmentAccess, useAdjustmentCommand } from './commands.js';
import { AdjustmentDetail } from './AdjustmentDetail.js';
import { display, editableOrder, type filters, listPath, rangeLabel, statusOptions, type Head } from './model.js';
import { OrgChoice } from './OrgChoice.js';
import './adjustment.css';

type Filter = keyof typeof filters;
export function AdjustmentPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  const voiding = params.get('action') === 'void';
  const [page, setPage] = useState<PageRequest>({ page: 1, pageSize: 15 });
  const [conditions, setConditions] = useState<Partial<Record<Filter, string>>>({});
  const [creating, setCreating] = useState(false);
  const permissions = useAdjustmentAccess();
  const visible = (code: string) => permissions.field(code).visible;
  const list = useRemote<PageResult<Head>>(listPath(page, conditions, visible));
  const select = (id?: string, action?: string) => setParams(id ? { id, ...(action ? { action } : {}) } : {});
  const created = useAdjustmentCommand(
    undefined,
    (id) => {
      setCreating(false);
      list.refresh();
      select(id);
    },
    permissions,
  );
  const set = (name: Filter, value?: string) => {
    setConditions((previous) => ({ ...previous, [name]: value }));
    setPage((previous) => ({ ...previous, page: 1 }));
  };

  const columns = useColumns(select, permissions.void);
  const forbidden = list.error instanceof ApiError && list.error.status === 403;
  return (
    <>
      <ListPage
        title={text.title}
        data={list.data ?? { items: [], total: 0 }}
        rowKey="id"
        columns={columns}
        page={page}
        onPageChange={setPage}
        filters={!forbidden && <ListFilters conditions={conditions} set={set} visible={visible} />}
        actions={
          permissions.add && (
            <Button type="primary" onClick={() => setCreating(true)}>
              {text.application}
            </Button>
          )
        }
        exportAction={null}
        loading={list.loading}
        error={list.error}
        retry={list.refresh}
      />
      {id && <AdjustmentDetail key={id} id={id} voiding={voiding} close={() => select()} refreshList={list.refresh} />}
      {creating && <ApplicationForm command={created} onClose={() => setCreating(false)} />}
    </>
  );
}

export function ApprovalAdjustmentPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const id = params.get('id');
  if (!id) return <PageState kind="not-found" />;
  return <AdjustmentDetail key={id} id={id} close={() => void navigate('/approval')} />;
}

function useColumns(select: (id: string, action?: string) => void, voidAllowed: boolean): TableColumnsType<Head> {
  const { userId, timezone } = useSession();
  return [
    {
      title: labels.subject,
      render: (_, row) => (
        <Button type="link" onClick={() => select(row.id)} aria-label={row.subject || text.open}>
          {display(row.subject)}
        </Button>
      ),
    },
    ...(
      [
        ['code', 'code'],
        ['effectiveDate', 'effectiveDate'],
        ['approvalSubjectOrgId', 'approvalSubjectOrgName'],
        ['approvalStatus', 'approvalStatusLabel'],
        ['executionStatus', 'executionStatusLabel'],
        ['executionNote', 'executionNote'],
        ['createdBy', 'createdByName'],
      ] as const
    ).map(([label, key]) => ({ title: labels[label], dataIndex: key, render: display })),
    { title: labels.adjustmentRange, render: (_, row) => rangeLabel(row.adjustmentRange) },
    {
      title: labels.createdAt,
      render: (_, row) => (row.createdAt ? formatInstant(row.createdAt, timezone) : display(null)),
    },
    ...(voidAllowed
      ? [
          {
            title: text.action,
            render: (_: unknown, row: Head) =>
              editableOrder(row, userId) ? (
                <Button type="link" onClick={() => select(row.id, 'void')}>
                  {text.void}
                </Button>
              ) : null,
          },
        ]
      : []),
  ];
}

function ListFilters({
  conditions,
  set,
  visible,
}: {
  conditions: Partial<Record<Filter, string>>;
  set(name: Filter, value?: string): void;
  visible(field: string): boolean;
}) {
  const date = (name: 'effectiveFrom' | 'effectiveTo', label: string) => (
    <input
      type="date"
      aria-label={label}
      value={conditions[name] ?? ''}
      onChange={(event) => set(name, event.target.value)}
    />
  );
  return (
    <Space wrap>
      {visible('approvalSubjectOrgId') && (
        <OrgChoice
          label={labels.approvalSubjectOrgId}
          includeDisabled
          value={conditions.approvalSubjectOrgId}
          onChange={(value) => set('approvalSubjectOrgId', typeof value === 'string' ? value : undefined)}
        />
      )}
      {visible('effectiveDate') && (
        <Space aria-label={labels.effectiveDate}>
          {date('effectiveFrom', text.from)}
          {date('effectiveTo', text.to)}
        </Space>
      )}
      {visible('approvalStatus') && (
        <Select
          aria-label={labels.approvalStatus}
          placeholder={labels.approvalStatus}
          allowClear
          style={{ minWidth: 130 }}
          options={statusOptions}
          value={conditions.approvalStatus}
          onChange={(value) => set('approvalStatus', value)}
        />
      )}
    </Space>
  );
}

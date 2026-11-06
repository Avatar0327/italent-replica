import { APPROVAL_TYPES } from '@italent/domain';
import { Button, Checkbox, Space, type TableColumnsType } from 'antd';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { formatInstant } from './ApprovalDetail.js';
import { centerText as c, instanceStatus, messages as m } from './messages.js';
import type { ApplicationRow, ApplicationSort } from './types.js';

interface Option {
  value: string;
  label: string;
}
/** 类别选项取复刻已有的业务类型；原站选项文案未取证（未决）。 */
export const categoryOptions: Option[] = Object.entries(APPROVAL_TYPES).map(([value, type]) => ({
  value,
  label: type.name,
}));
/** 状态选项只列复刻有的 6 种，顺序与服务端状态排序一致；原站的“空(未填写)”“已完成”复刻没有对应状态。 */
export const statusOptions: Option[] = ['running', 'approved', 'disapproved', 'cancelled', 'returned', 'withdrawn'].map(
  (value) => ({ value, label: instanceStatus[value]!.label }),
);

interface ColumnContext {
  timezone: string;
  categories: string[];
  statuses: string[];
  sort?: ApplicationSort;
  onOpen(row: ApplicationRow): void;
  onFilter(next: { categories?: string[]; statuses?: string[] }): void;
  onSort(next: ApplicationSort): void;
}

/** 多选筛选下拉：勾选只改草稿，点“确定”才应用并回到第 1 页。 */
function CheckFilter({ options, applied, apply }: { options: Option[]; applied: string[]; apply(v: string[]): void }) {
  const [draft, setDraft] = useState(applied);
  return (
    <div className="approval-filter-dropdown">
      <Checkbox.Group options={options} value={draft} onChange={(values) => setDraft(values.map(String))} />
      <Space className="approval-filter-actions">
        <Button size="small" onClick={() => (setDraft([]), apply([]))}>
          {c.filterReset}
        </Button>
        <Button size="small" type="primary" onClick={() => apply(draft)}>
          {c.filterConfirm}
        </Button>
      </Space>
    </div>
  );
}
const initial = (name: string) => name.slice(-2);

function sortingOf(context: ColumnContext) {
  const sortOrder = (field: ApplicationSort['field']) => {
    // 没有显式排序时服务端按申请时间倒序，表头同步显示
    const current = context.sort ?? { field: 'createdAt' as const, order: 'desc' as const };
    return current.field === field ? (current.order === 'asc' ? ('ascend' as const) : ('descend' as const)) : null;
  };
  return (field: ApplicationSort['field']) => {
    const toggle = () => context.onSort({ field, order: sortOrder(field) === 'ascend' ? 'desc' : 'asc' });
    return {
      sorter: true,
      sortOrder: sortOrder(field),
      onHeaderCell: () => ({
        onClick: toggle,
        onKeyDown: (event: { key: string }) => event.key === 'Enter' && toggle(),
      }),
    };
  };
}
function filterOf(context: ColumnContext) {
  return (options: Option[], applied: string[], key: 'categories' | 'statuses') => ({
    filtered: applied.length > 0,
    filterDropdown: ({ close }: { close(): void }): ReactNode => (
      <CheckFilter
        key={applied.join(',')}
        options={options}
        applied={applied}
        apply={(values) => (context.onFilter({ [key]: values }), close())}
      />
    ),
  });
}

/** 列序与宽度按原站 §2.10：标题 174 / 类别 174 / 发起人 164 / 当前处理人 144 / 审批状态 174 / 申请理由 174 / 申请时间 192。 */
export function applicationColumns(context: ColumnContext): TableColumnsType<ApplicationRow> {
  const sortable = sortingOf(context);
  const filter = filterOf(context);
  const text = (value: string | undefined) => value || c.placeholder;
  return [
    {
      title: c.titleColumn,
      key: 'title',
      width: 174,
      ellipsis: true,
      render: (_: unknown, row) => (
        <Button type="link" className="approval-table-link" onClick={() => context.onOpen(row)}>
          {row.title}
        </Button>
      ),
    },
    {
      title: c.category,
      key: 'category',
      width: 174,
      render: (_: unknown, row) => text(row.approvalTypeName),
      ...filter(categoryOptions, context.categories, 'categories'),
    },
    {
      title: c.initiator,
      key: 'initiator',
      width: 164,
      render: (_: unknown, row) =>
        row.initiatorName ? (
          <span className="approval-initiator">
            <span className="approval-record-mark" aria-hidden>
              {initial(row.initiatorName)}
            </span>
            {row.initiatorName}
          </span>
        ) : (
          c.placeholder
        ),
    },
    {
      title: c.currentHandler,
      key: 'handlers',
      width: 144,
      render: (_: unknown, row) => text(row.currentHandlers.join(c.handlerSeparator)),
    },
    {
      title: m.status,
      key: 'status',
      width: 174,
      render: (_: unknown, row) => instanceStatus[row.status ?? '']?.label ?? row.status,
      ...filter(statusOptions, context.statuses, 'statuses'),
      ...sortable('status'),
    },
    // 实例没有统一的申请理由来源，不伪造
    { title: c.applyReason, key: 'reason', width: 174, render: () => c.placeholder },
    {
      title: c.applyTime,
      key: 'createdAt',
      width: 192,
      render: (_: unknown, row) => formatInstant(row.createdAt, context.timezone),
      ...sortable('createdAt'),
    },
  ];
}

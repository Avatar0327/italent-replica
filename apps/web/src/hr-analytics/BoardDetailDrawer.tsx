import { useRef, type ReactNode } from 'react';
import { Alert, Select } from 'antd';
import { DetailPage } from '../foundation/templates.js';
import { ReadOnlyReportTable } from '../hr-reports/ReportTable.js';
import { m as report } from '../hr-reports/messages.js';
import type { DisplayTable, RosterPage } from '../hr-reports/model.js';
import { ReadState } from './ReadState.js';
import { m } from './messages.js';
import { canRetryRead } from './model.js';

export function BoardDetailDrawer({
  title,
  asOf,
  read,
  table,
  controls,
  missing,
  waiting,
  drawer,
  changePage,
  retry,
}: {
  title: string;
  asOf: string;
  read: {
    loading: boolean;
    error?: unknown;
    data?: Pick<RosterPage, 'hasDataPermission' | 'page' | 'pageSize'>;
  };
  table?: DisplayTable;
  controls?: ReactNode;
  missing?: string;
  waiting: boolean;
  drawer: { open: boolean; onClose(): void; afterClose(): void };
  changePage(page: number): void;
  retry(): void;
}) {
  const { data, error, loading } = read;
  const summaryFocus = useRef<HTMLParagraphElement>(null);
  return (
    <DetailPage
      {...drawer}
      title={title}
      summary={
        drawer.open && (
          <>
            <p ref={summaryFocus} tabIndex={-1}>
              {m.asOf(asOf)}
            </p>
            {controls}
            <ReadState
              loading={loading}
              error={error}
              detail
              missing={missing}
              waiting={waiting}
              retry={canRetryRead(error) ? retry : undefined}
            />
            {data?.hasDataPermission === false && <Alert type="info" message={report.noScope} />}
            {data?.hasDataPermission === true && table && (
              <ReadOnlyReportTable
                table={table}
                page={data.page}
                pageSize={data.pageSize}
                paginationDisabled={waiting}
                changePage={(page) => {
                  // 换页会卸载分页器。先把焦点移到抽屉内持续挂载的摘要。
                  summaryFocus.current?.focus({ preventScroll: true });
                  changePage(page);
                }}
                emptyText={m.empty}
              />
            )}
          </>
        )
      }
    />
  );
}

export function BoardGroupSelector({
  options,
  group,
  required,
  disabled,
  change,
}: {
  options: readonly { key: string; label: string }[];
  group?: string;
  required?: boolean;
  disabled: boolean;
  change(group?: string): void;
}) {
  if (!options.length) return null;
  // 选择值用位置承载，完整的分组键只从当前概览回执取。
  const position = options.findIndex(({ key }) => key === group);
  return (
    <div className="hr-structure-group">
      <span>{m.group}</span>
      <Select<number>
        aria-label={m.group}
        value={required && position < 0 ? undefined : position}
        placeholder={m.chooseGroup}
        options={[
          ...(required ? [] : [{ value: -1, label: m.allGroups }]),
          ...options.map(({ label }, value) => ({ value, label })),
        ]}
        disabled={disabled}
        onChange={(index) => change(options[index]?.key)}
      />
    </div>
  );
}

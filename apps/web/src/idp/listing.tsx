import { Alert, Button, Input } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../foundation/client.js';
import { t } from './messages.js';

/**
 * 列表接口不返回总数（见 api.ts loadAll），三张列表都在前端筛选后按 15 条/页分页；
 * 数据变少导致当前页越界时退回最后一页，避免出现“有数据却显示空页”。
 */
export function useLocalPage<T>(rows: readonly T[], loading: boolean) {
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const pageNumber = Math.min(page.page, Math.max(1, Math.ceil(rows.length / page.pageSize)));
  useEffect(() => {
    if (!loading && pageNumber !== page.page) setPage((value) => ({ ...value, page: pageNumber }));
  }, [loading, pageNumber, page.page]);
  return {
    page: { ...page, page: pageNumber },
    shown: rows.slice((pageNumber - 1) * page.pageSize, pageNumber * page.pageSize),
    change: setPage,
    first: () => setPage((value) => ({ ...value, page: 1 })),
  };
}

/** 写动作失败提示；冲突 / 结果未知时给“刷新”，刷新后才允许显式重提（AGENTS.md §10）。 */
export function ActionError({ error, reset }: { error: unknown; reset?: (() => void) | false }) {
  return (
    <Alert
      type="error"
      showIcon
      message={error instanceof ApiError ? error.message : t.actionFailed}
      action={reset && <Button onClick={reset}>{t.actions.refresh}</Button>}
    />
  );
}

export function NameSearch({ value, change }: { value?: string; change(value: string): void }) {
  return (
    <Input.Search
      allowClear
      aria-label={t.search}
      placeholder={t.search}
      value={value}
      onChange={(event) => change(event.target.value)}
    />
  );
}

export function yesNo(value?: boolean) {
  if (value === undefined) return t.noValue;
  return value ? t.yes : t.no;
}

/** 列表头部按钮：有新增权限时给“新增”，其余按钮放中间，“刷新”固定在最后。 */
export function HeaderActions({
  create,
  refresh,
  children,
}: {
  create?: false | (() => void);
  refresh(): void;
  children?: ReactNode;
}) {
  return (
    <>
      {create && (
        <Button type="primary" onClick={create}>
          {t.actions.create}
        </Button>
      )}
      {children}
      <Button onClick={refresh}>{t.actions.refresh}</Button>
    </>
  );
}

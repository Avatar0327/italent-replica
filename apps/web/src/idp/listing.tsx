import { Button, Input, Modal, Typography } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import type { Command } from './api.js';
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

/** 命令状态 + 命令 ID：锁住时显示命令 ID，便于按原单核对，不再发起新命令（F-123 内核口径）。 */
export function CommandNotice({ command }: { command: Command }) {
  return (
    <>
      <CommandStatus submission={command} />
      {command.locked && command.state?.command && (
        <Typography.Paragraph type="secondary" className="idp-command-id">
          {t.commandId}：{command.state.command.id}
        </Typography.Paragraph>
      )}
    </>
  );
}

/** 确认类写入的弹窗：命令锁住时“确定”禁用，关闭再打开仍显示同一条命令的状态。 */
export function CommandDialog(props: {
  title: string;
  command: Command;
  ok(): void;
  close(): void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const { title, command, ok, close, disabled, children } = props;
  return (
    <Modal
      open
      title={title}
      onCancel={close}
      okText={t.actions.ok}
      cancelText={t.actions.back}
      onOk={ok}
      okButtonProps={{ disabled: disabled || command.locked, loading: command.busy }}
      destroyOnHidden
    >
      <CommandNotice command={command} />
      {children}
    </Modal>
  );
}

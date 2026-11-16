import { Button } from 'antd';
import { useState } from 'react';
import type { FormField } from '../foundation/FormOverlay.js';
import { customFieldsNoticeText as text } from './messages.js';

/** 各模块定义目录读取（useRemote / useRead 的返回值）里用到的部分。 */
interface DefinitionsRead {
  error?: unknown;
  loading: boolean;
  refresh(): void;
}
export interface CustomFieldsNoticeState {
  /** failed：读取失败（网络错误或非 2xx，含 403、5xx）；retrying：点重试后重新读取中；其余情况没有提示。 */
  status?: 'failed' | 'retrying';
  retry(): void;
}

function noticeStatus(requested: boolean, read: DefinitionsRead, retried: boolean) {
  if (!requested) return undefined;
  if (read.error !== undefined) return 'failed';
  return retried && read.loading ? 'retrying' : undefined;
}
/**
 * F-527（DEC-918）：组织、人员、兼职的自定义字段定义目录读取失败时不再静默当“无字段”，自定义字段区给一行非阻塞提示
 * 和“重试”。失败与重试期间表单其余部分照常可填可提交，提交按无自定义字段处理（不带也不清空 custom:<id>）。
 * 首次读取的加载态仍由各处原样处理；requested 为假（无 custom:* 查看权，不请求目录）时始终没有提示。
 */
export function useCustomFieldsNotice(requested: boolean, read: DefinitionsRead): CustomFieldsNoticeState {
  const [retried, setRetried] = useState(false);
  return {
    status: noticeStatus(requested, read, retried),
    retry: () => {
      setRetried(true);
      read.refresh();
    },
  };
}
/** 失败显示“自定义字段加载失败，重试”，重试中显示加载态；没有提示时不渲染。 */
export function CustomFieldsNotice({ notice }: { notice: CustomFieldsNoticeState }) {
  if (notice.status === 'retrying') return <span role="status">{text.loading}</span>;
  if (notice.status !== 'failed') return null;
  return (
    <span role="status">
      {text.failed}
      <Button type="link" size="small" onClick={notice.retry}>
        {text.retry}
      </Button>
    </span>
  );
}
/** FormOverlay 分组里的提示行：只读伪字段（同 org/OrgEditor info()），不进可提交字段，也不进请求体。 */
export function customFieldsNoticeField(notice: CustomFieldsNoticeState): FormField[] {
  if (!notice.status) return [];
  const display = <CustomFieldsNotice notice={notice} />;
  return [
    { name: '__customFieldsNotice', label: '', control: null, access: { visible: true, editable: false }, display },
  ];
}

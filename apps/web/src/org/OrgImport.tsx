import { Alert, Button, Modal, Space, Table } from 'antd';
import { useState } from 'react';
import { FormOverlay, useApiClient, type FormField } from '../foundation/index.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import {
  orgImportPath,
  orgImportReceipt,
  orgImportResource,
  orgImportTemplate,
  parseOrgImport,
  type ImportRow,
  type OrgImportResult,
} from './import-model.js';
import { importText as m, pageText } from './messages.js';

interface FileProps {
  value?: ImportRow[];
  disabled?: boolean;
  onChange?(value: ImportRow[] | undefined): void;
}
/** 读取模板 JSON 为 rows；读不出时清空值并就地提示，不发请求。锁定时由 LockedField 下发 disabled。 */
function ImportFile({ value, disabled, onChange }: FileProps) {
  const [error, setError] = useState<string>();
  return (
    <Space direction="vertical">
      <input
        type="file"
        accept=".json,application/json"
        aria-label={m.pick}
        disabled={disabled}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const parsed = parseOrgImport(await file.text());
          setError('error' in parsed ? parsed.error : undefined);
          onChange?.('rows' in parsed ? parsed.rows : undefined);
        }}
      />
      {!!value?.length && <span>{m.loaded(value.length)}</span>}
      {error && <Alert type="error" showIcon message={error} />}
    </Space>
  );
}
const readOnly = { visible: true, editable: false };
const fields: FormField[] = [
  {
    name: '__hint',
    label: pageText.notice,
    control: null,
    access: readOnly,
    display: (
      <Space direction="vertical" size={4}>
        <span>{m.hint}</span>
        <a href={orgImportTemplate} download>
          {m.template}
        </a>
      </Space>
    ),
  },
  {
    name: 'rows',
    label: m.file,
    control: <ImportFile />,
    // 入口已按导入按钮（import@list）放出；行内字段的新建 / 修改权由服务端逐行校验，整批成功或整批失败。
    access: { visible: true, editable: true },
    rules: [{ required: true, message: m.required }],
  },
];

/**
 * 组织导入接 F-142 内核：命令 ID、锁定、被拒提示与结果未知锁定都由内核负责。
 * 导入没有原单可回读，结果未知时保持锁定、重开仍锁定，待刷新列表核对（DEC-502①g）。
 */
export function OrgImport({ onClose, onImported }: { onClose(): void; onImported(results: OrgImportResult[]): void }) {
  const api = useApiClient();
  const command = useCommandForm(orgImportResource);
  const close = () => {
    command.clear();
    onClose();
  };
  const submit = async (values: Record<string, unknown>) => {
    let results: OrgImportResult[] | undefined;
    const outcome = await command.submit({
      values: { rows: values.rows },
      baseline: {},
      editableFields: ['rows'],
      revision: 0,
      send: async (sent) => {
        const receipt = await api.request<unknown>(orgImportPath, { method: 'POST', command: sent });
        results = orgImportReceipt(sent.body.rows as ImportRow[], receipt);
        // 回执与提交行对不上：不当作成功，按结果未知锁定。
        if (!results) throw new Error(kernel.invalidReceipt);
        return { id: sent.id };
      },
    });
    if (outcome.status !== 'done' || !results) throw outcome.error ?? new Error(kernel.unknown);
    onImported(results);
  };
  return (
    <FormOverlay
      mode="modal"
      recordKey={orgImportResource}
      submission={command}
      open
      title={m.title}
      onClose={close}
      onSubmit={submit}
      groups={[{ title: pageText.basic, fields }]}
    />
  );
}

/** 导入成功后的逐行回执：原系统编码、机构编码、新建 / 更新。 */
export function OrgImportResults({ results, onClose }: { results: OrgImportResult[]; onClose(): void }) {
  return (
    <Modal open title={m.result} width={640} onCancel={onClose} footer={<Button onClick={onClose}>{m.close}</Button>}>
      <Table
        size="small"
        rowKey={(row) => row.sourceCode}
        pagination={false}
        dataSource={results}
        columns={[
          { key: 'sourceCode', title: m.sourceCode, dataIndex: 'sourceCode' },
          { key: 'code', title: m.code, dataIndex: 'code' },
          { key: 'status', title: m.status, dataIndex: 'status', render: (value: string) => m.statuses[value] },
          { key: 'reason', title: m.reason, dataIndex: 'reason', render: (value?: string | null) => value ?? '—' },
        ]}
      />
    </Modal>
  );
}

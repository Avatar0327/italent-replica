import { Alert, Button, Modal, Space, Table } from 'antd';
import { useRef, useState } from 'react';
import { FormOverlay, useApiClient, type FormField } from '../foundation/index.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { useCommandForm, type CommandForm } from '../foundation/forms/useCommandForm.js';
import {
  orgImportPath,
  orgImportReceipt,
  orgImportResource,
  orgImportTemplate,
  orgRecordPath,
  parseOrgImport,
  rereadImportRows,
  type ImportGate,
  type ImportRow,
  type OrgImportResult,
} from './import-model.js';
import { importText as m, pageText } from './messages.js';
import { orgImportable } from './page-model.js';
import type { PageAccess } from './page-support.js';

interface FileProps {
  value?: ImportRow[];
  disabled?: boolean;
  gate: ImportGate;
  onChange?(value: ImportRow[] | undefined): void;
}
/**
 * 读取模板 JSON 为 rows；读不出或无权写入时清空值并就地提示，不发请求。锁定时由 LockedField 下发 disabled。
 * 换文件先清掉旧值，读完前必填校验拦住保存；读取期间又换了文件，较早的结果作废，不覆盖后选的文件。
 */
function ImportFile({ value, disabled, gate, onChange }: FileProps) {
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState(false);
  const picked = useRef(0);
  const pick = async (file: File | undefined) => {
    const current = ++picked.current;
    onChange?.(undefined);
    setError(undefined);
    setReading(!!file);
    if (!file) return;
    // 文件读不出（被移走、无权限）与内容不合法同样就地提示，不发请求。
    const text = await file.text().catch(() => '');
    if (current !== picked.current) return;
    setReading(false);
    const parsed = parseOrgImport(text, gate);
    setError('error' in parsed ? parsed.error : undefined);
    onChange?.('rows' in parsed ? parsed.rows : undefined);
  };
  return (
    <Space direction="vertical">
      <input
        type="file"
        accept=".json,application/json"
        aria-label={m.pick}
        disabled={disabled}
        onChange={(event) => void pick(event.target.files?.[0])}
      />
      {reading && <span>{m.reading}</span>}
      {!reading && !!value?.length && <span>{m.loaded(value.length)}</span>}
      {error && <Alert type="error" showIcon message={error} />}
    </Space>
  );
}
const readOnly = { visible: true, editable: false };
/** 导入文件只在有导入入口的口径下可写（orgImportable），不固定标成可编辑；逐行写权在读取文件时按 gate 预检。 */
function importFields(access: PageAccess): FormField[] {
  return [
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
      control: <ImportFile gate={access} />,
      access: { visible: true, editable: orgImportable(access) },
      rules: [{ required: true, message: m.required }],
    },
  ];
}

/**
 * 组织导入接 F-142 内核：命令 ID、锁定、被拒提示与结果未知锁定都由内核负责。
 * - 结果未知：导入没有原单可回读，保持锁定、重开仍锁定，待刷新列表核对（DEC-502①g）。
 * - 更新行版本冲突（409 REVISION_CONFLICT）：内核“重读最新版本”按 orgId 读回各行最新版本，核对差异后
 *   “已核对差异，继续编辑”解锁，用户再点保存显式重提（DEC-502①b）。导入没有单一原单，以恢复槽作批次标识，
 *   供内核核对读回结果属于本批。
 * - 基线取本次提交的行：行未被人工改过，重读后跟随最新版本回填，重提即带新的 expectedRevision。
 */
export function OrgImport(props: {
  access: PageAccess;
  onClose(): void;
  onImported(results: OrgImportResult[]): void;
}) {
  const api = useApiClient();
  const command = useCommandForm(orgImportResource);
  const close = () => {
    command.clear();
    props.onClose();
  };
  const reread = () =>
    command.reread(async () => ({
      id: orgImportResource,
      revision: 0,
      values: {
        rows: await rereadImportRows((command.state?.values.rows as ImportRow[] | undefined) ?? [], (orgId) =>
          api.request<unknown>(orgRecordPath(orgId)),
        ),
      },
    }));
  const submission: CommandForm = { ...command, reload: command.status === 'conflict' ? reread : undefined };
  const submit = async (values: Record<string, unknown>) => {
    let results: OrgImportResult[] | undefined;
    const outcome = await command.submit({
      values: { rows: values.rows },
      baseline: { rows: values.rows },
      editableFields: ['rows'],
      revision: 0,
      businessId: orgImportResource,
      send: async (sent) => {
        const receipt = await api.request<unknown>(orgImportPath, { method: 'POST', command: sent });
        results = orgImportReceipt(sent.body.rows as ImportRow[], receipt);
        // 回执与提交行对不上：不当作成功，按结果未知锁定。
        if (!results) throw new Error(kernel.invalidReceipt);
        return { id: orgImportResource };
      },
    });
    if (outcome.status !== 'done' || !results) throw outcome.error ?? new Error(kernel.unknown);
    props.onImported(results);
  };
  return (
    <FormOverlay
      mode="modal"
      recordKey={orgImportResource}
      submission={submission}
      open
      title={m.title}
      onClose={close}
      onSubmit={submit}
      groups={[{ title: pageText.basic, fields: importFields(props.access) }]}
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

import { EXIT_IMPORT_BUTTON } from '@italent/domain';
import { Alert, App, Button, Modal, Space, Table, Tag } from 'antd';
import { useRef, useState } from 'react';
import { newCommand } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { ui } from '../foundation/messages.js';
import { canButton, type ObjectPermission } from '../foundation/permission-model.js';
import { useApiClient } from '../foundation/Session.js';
import { useExitCommand } from './ExitCommands.js';
import { x, xi } from './messages.js';
import {
  importPath,
  importRowsOf,
  parseImportPreview,
  parseImportReceipt,
  previewPath,
  warningText,
  withRejectedRows,
  type ImportPreview,
  type ImportRow,
  type PreviewRow,
} from './exit-import-model.js';
import { readXlsx } from './xlsx-reader.js';

/** 工具栏入口：新增权 + list 级按钮 Employment.DimissionImport（与 employment/policy.ts 两条导入路由同口径）。 */
export const importEntryVisible = (p: ObjectPermission | undefined) =>
  !!p?.dataOperations.create && canButton(p, EXIT_IMPORT_BUTTON, 'list');

export function ExitImportEntry(props: { permission: ObjectPermission | undefined; onImported(): Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  if (!importEntryVisible(props.permission)) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>{xi.entry}</Button>
      {open && <ExitImport onClose={() => setOpen(false)} onImported={props.onImported} />}
    </>
  );
}

type Loaded = { rows: ImportRow[]; preview: ImportPreview };
type Picked = { reading?: boolean; error?: string; loaded?: Loaded };
/**
 * 选文件即解析并调 preview（只读，不进命令内核，同 ExitForm 的提交前检查）。
 * 读取期间又换了文件，较早的结果作废；读不出、列名不对、超过 100 行都就地提示，不发请求。
 */
function usePreview() {
  const api = useApiClient();
  const [state, setState] = useState<Picked>({});
  const picked = useRef(0);
  const load = async (file: File): Promise<Picked> => {
    const sheet = await file
      .arrayBuffer()
      .then((buffer) => readXlsx(new Uint8Array(buffer)))
      .catch(() => undefined);
    if (!sheet) return { error: xi.errors.unreadable };
    const parsed = importRowsOf(sheet);
    if ('error' in parsed) return parsed;
    const command = newCommand({ rows: parsed.rows });
    const raw = await api.request<unknown>(previewPath, { method: 'POST', command });
    return { loaded: { rows: parsed.rows, preview: parseImportPreview(raw, parsed.rows) } };
  };
  const pick = async (file: File | undefined) => {
    const current = ++picked.current;
    setState({ reading: !!file });
    if (!file) return;
    const next = await load(file).catch((error: unknown) => ({ error: (error as Error)?.message || ui.failed }));
    if (current === picked.current) setState(next);
  };
  return { ...state, pick, update: (loaded: Loaded) => setState({ loaded }) };
}

/**
 * 导入走 F-123 内核（useExitCommand，恢复槽 = 导入集合路径）：命令 ID、锁定、拒绝与结果未知都由内核负责。
 * 有超编警告或不可见的超编时后端 409 CONFIRMATION_REQUIRED，确认框（DEC-258）确认后带 confirmed: true 重提；
 * 重提是内核里的一次新提交，命令 ID（Idempotency-Key）随之换新（设计 §9.3），不沿用被拒那次的键。
 */
function ExitImport(props: { onClose(): void; onImported(): Promise<unknown> }) {
  const { message } = App.useApp();
  const file = usePreview();
  // 新建无对象：objects 传空列表，恢复槽为导入集合路径本身（不传则 id 缺失被内核判为无效对象）
  const cmd = useExitCommand(importPath, { revision: undefined, baseline: {} }, 'import', props.onImported, []);
  const loaded = file.loaded;
  const run = async () => {
    if (!loaded) return;
    let imported = 0;
    try {
      const done = await cmd.submit({}, [], {
        path: importPath,
        method: 'POST',
        noRevision: true,
        body: (_values, confirm) => ({ rows: loaded.rows, ...confirm }),
        accept: (raw) => void (imported = parseImportReceipt(raw, loaded.rows)),
      });
      if (!done) return;
      void message.success(xi.success(imported));
      props.onClose();
    } catch (error) {
      // 拒绝 / 结果未知由内核状态条显示；预览后数据变了（整批 400）再把逐行原因合进预览表
      const merged = withRejectedRows(loaded.preview, error);
      if (merged) file.update({ ...loaded, preview: merged });
    }
  };
  const preview = loaded?.preview;
  const busy = cmd.form.busy || cmd.disabled;
  const footer = (
    <Space>
      <Button onClick={props.onClose}>{xi.close}</Button>
      <Button
        type="primary"
        disabled={!preview || preview.summary.failed > 0 || file.reading || cmd.disabled}
        loading={cmd.form.busy}
        onClick={() => void run()}
      >
        {xi.submit}
      </Button>
    </Space>
  );
  return (
    <Modal open title={xi.entry} width={760} maskClosable={false} onCancel={props.onClose} footer={footer}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <span>{xi.hint}</span>
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          aria-label={xi.pick}
          disabled={busy}
          onChange={(event) => void file.pick(event.target.files?.[0])}
        />
        {file.reading && <span>{xi.reading}</span>}
        {file.error && <Alert type="error" showIcon message={file.error} />}
        {loaded && <PreviewTable preview={loaded.preview} rows={loaded.rows} />}
        <CommandStatus submission={cmd.form} />
      </Space>
    </Modal>
  );
}

const resultOf = (row: PreviewRow) =>
  !row.ok
    ? (['error', xi.results.failed] as const)
    : row.warnings.length
      ? (['warning', xi.results.warned] as const)
      : (['success', xi.results.ok] as const);

function PreviewTable({ preview, rows }: { preview: ImportPreview; rows: ImportRow[] }) {
  const sent = new Map(rows.map((row) => [row.rowNo, row]));
  return (
    <>
      <span>{xi.summary(preview.summary)}</span>
      {preview.summary.failed > 0 && <Alert type="error" showIcon message={xi.fixFirst} />}
      {preview.hiddenCount > 0 && <Alert type="warning" showIcon message={xi.hidden(preview.hiddenCount)} />}
      <Table<PreviewRow>
        size="small"
        rowKey="rowNo"
        pagination={false}
        dataSource={preview.rows}
        columns={[
          { key: 'rowNo', title: xi.table.rowNo, dataIndex: 'rowNo' },
          {
            key: 'employeeNo',
            title: xi.table.employeeNo,
            render: (_, row) => sent.get(row.rowNo)?.employeeNo ?? x.missing,
          },
          { key: 'name', title: xi.table.name, render: (_, row) => sent.get(row.rowNo)?.name ?? x.missing },
          {
            key: 'result',
            title: xi.table.result,
            render: (_, row) => <Tag color={resultOf(row)[0]}>{resultOf(row)[1]}</Tag>,
          },
          {
            key: 'detail',
            title: xi.table.detail,
            render: (_, row) =>
              [...row.errors.map((issue) => issue.message), ...row.warnings.map(warningText)].map((line, i) => (
                <div key={i}>{line}</div>
              )),
          },
        ]}
      />
    </>
  );
}

import { EXIT_IMPORT_BUTTON } from '@italent/domain';
import { Alert, App, Button, Modal, Space } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { ApiError } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useConflictCommand, type Sending } from '../foundation/forms/ConflictCommands.js';
import { canButton, type ObjectPermission } from '../foundation/permission-model.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { xi } from './messages.js';
import { importPath, importRowsOf, parseImportReceipt, type ImportRow } from './exit-import-model.js';
import { ExitImportTemplate } from './ExitImportTemplate.js';
import { XlsxError, readXlsx } from './xlsx-reader.js';

/** 工具栏入口：新增权 + list 级按钮 Employment.DimissionImport（与 employment/policy.ts 同口径）。 */
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

type Loaded = { rows: ImportRow[]; fileName: string };
type Picked = { reading?: boolean; error?: string; loaded?: Loaded };
async function load(file: File): Promise<Picked> {
  try {
    const parsed = importRowsOf(await readXlsx(new Uint8Array(await file.arrayBuffer())), file.name);
    return 'error' in parsed ? parsed : { loaded: { rows: parsed.rows, fileName: file.name } };
  } catch (error) {
    return { error: error instanceof XlsxError && error.reason === 'limit' ? xi.errors.tooBig : xi.errors.unreadable };
  }
}

/** F-123 内核持有页面级原命令；成功后的页面动作只由仍存活的弹窗执行（F-493 §9.1）。 */
function useImportDialog(props: { onClose(): void; onImported(): Promise<unknown> }) {
  const { message } = App.useApp();
  const api = useApiClient();
  const session = useSession();
  const location = useLocation();
  const active = useRef({ live: true });
  useEffect(() => {
    const ticket = { live: true };
    active.current = ticket;
    return () => {
      ticket.live = false;
    };
  }, [location.key, session.tenantId, session.identityKey]);
  const [file, setFile] = useState<Picked>({});
  const picked = useRef(0);
  const cmd = useConflictCommand(importPath, { revision: -1, values: {}, objects: [] }, undefined, {
    action: 'import',
  });
  const close = () => {
    active.current.live = false;
    props.onClose();
  };
  const pick = async (next: File | undefined) => {
    const current = ++picked.current;
    const ticket = active.current;
    setFile({ reading: !!next });
    if (!next) return;
    const loaded = await load(next);
    if (ticket.live && current === picked.current) setFile(loaded);
  };
  const send = async ({ command }: Sending) => {
    try {
      const raw = await api.request(importPath, { method: 'POST', command: { ...command, revision: undefined } });
      parseImportReceipt(raw, command.body.rows as ImportRow[]);
      return { id: importPath };
    } catch (error) {
      // 确定拒绝仍交内核解锁；原始原因码与英文校验文本不直接展示（DEC-045）。
      if (error instanceof ApiError && [400, 413].includes(error.status)) {
        const reason = error.status === 413 ? xi.errors.tooLarge : error.serverMessage;
        throw new ApiError(
          error.status,
          error.code,
          'fields',
          reason && /[\u4e00-\u9fff]/.test(reason) ? reason : xi.errors.invalid,
        );
      }
      throw error;
    }
  };
  const commit = async () => {
    const ticket = active.current;
    if (cmd.form.busy) return;
    try {
      if (cmd.form.status === 'unknown') await cmd.replay(send);
      else if (file.loaded) await cmd.run({ values: file.loaded, editableFields: ['rows', 'fileName'], send });
      else return;
      if (!ticket.live) return;
      close();
      void message.success(xi.success);
      // 已确认 202 后列表读取失败不能把原命令变成结果未知。
      await props.onImported().catch(() => undefined);
    } catch {
      // 拒绝与结果未知均由内核状态条展示，文件选择保留在当前弹窗。
    }
  };
  return { cmd, file, close, pick, commit };
}

function ExitImport(props: { onClose(): void; onImported(): Promise<unknown> }) {
  const { cmd, file, close, pick, commit } = useImportDialog(props);
  const unknown = cmd.form.status === 'unknown';
  return (
    <Modal
      open
      title={xi.entry}
      width={760}
      maskClosable={false}
      onCancel={close}
      footer={
        <Space>
          <Button onClick={close}>{xi.close}</Button>
          <Button
            type="primary"
            loading={cmd.form.busy}
            disabled={unknown ? cmd.form.busy : !file.loaded || file.reading || cmd.form.locked}
            onClick={() => void commit()}
          >
            {unknown ? xi.replay : xi.submit}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" className="exit-import">
        <span>{xi.hint}</span>
        <ExitImportTemplate />
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          aria-label={xi.pick}
          disabled={cmd.form.locked}
          onChange={(event) => void pick(event.target.files?.[0])}
        />
        {file.error && <Alert type="error" showIcon message={file.error} />}
        <CommandStatus submission={cmd.form} />
      </Space>
    </Modal>
  );
}

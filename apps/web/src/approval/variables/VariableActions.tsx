// 列表行操作（规格 30 §三）：编辑 / 启用 / 停用 / ▾查看引用流程；不提供删除（DEC-874）。
// 启停经 F-123 内核 useConflictCommand（If-Match 本行版本 + 幂等键）；停用先读引用、确认后带 acknowledgedReferenceCount。
import { Button, Dropdown, Popconfirm, Space } from 'antd';
import { rejectionMessage } from '../../foundation/client.js';
import { useApiClient } from '../../foundation/Session.js';
import { CommandStatus } from '../../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../../foundation/forms/ConflictCommands.js';
import { m } from './messages.js';
import {
  VARIABLES_PATH,
  parseReceipt,
  parseReferences,
  parseRow,
  rowActions,
  rowPath,
  type VariableRow,
} from './model.js';
import type { useImpactConfirm } from './References.js';

const snapshotOf = (row: VariableRow) => ({ id: row.id, revision: row.revision, values: { ...row } });

/** 启停命令：结果未知时命令钉在本行、按钮锁定待回查；其余失败（含 409 引用已变化）提示原因并刷新，不自动重提。 */
function useRowCommand(row: VariableRow, saved: () => void, failed: (reason: string) => void) {
  const api = useApiClient();
  const read = async () => snapshotOf(parseRow(await api.request<unknown>(rowPath(row.id))));
  const writer = useConflictCommand(VARIABLES_PATH, snapshotOf(row), read, { action: 'row' });
  const run = async (kind: 'enable' | 'disable', acknowledged?: number) => {
    try {
      await writer.run({
        values: {},
        editableFields: [],
        send: async ({ command }) => {
          const body = acknowledged === undefined ? {} : { acknowledgedReferenceCount: acknowledged };
          const raw = await api.request(rowPath(row.id, kind), { method: 'POST', command: { ...command, body } });
          return parseReceipt(raw, { id: row.id, revision: (command.revision ?? 0) + 1 });
        },
      });
      saved();
    } catch (error) {
      if (writer.form.peek()?.status === 'unknown') return;
      failed(rejectionMessage(error));
      writer.form.clear();
      saved();
    }
  };
  return { api, form: writer.form, run };
}

export function VariableActions(props: {
  row: VariableRow;
  impact: ReturnType<typeof useImpactConfirm>;
  edit(): void;
  references(): void;
  saved(): void;
  /** 失败原因显示在列表上方（不依赖静态 message，切页签前一直可见）。 */
  failed(reason: string): void;
}) {
  const { row, impact, edit, references, saved, failed } = props;
  const { api, form, run } = useRowCommand(row, saved, failed);
  const locked = form.locked;
  const actions = rowActions(row.status);
  // 停用前影响确认：引用清单读失败就不停用（保守），提示原因
  const disable = async () => {
    let refs: ReturnType<typeof parseReferences>;
    try {
      refs = parseReferences(await api.request<unknown>(rowPath(row.id, 'references')));
    } catch (error) {
      failed(rejectionMessage(error));
      return;
    }
    const ok = await impact.ask({
      title: m.impactTitle(m.disable),
      warning: m.impactWarning,
      plain: m.confirmDisable(row.scope, row.name),
      items: refs.items,
    });
    if (ok) await run('disable', refs.total);
  };
  return (
    <Space direction="vertical" size={0}>
      <Space size={4}>
        <Button type="link" size="small" disabled={locked} onClick={edit}>
          {m.edit}
        </Button>
        {actions.disable && (
          <Button type="link" size="small" danger disabled={locked} onClick={() => void disable()}>
            {m.disable}
          </Button>
        )}
        {actions.enable && (
          <Popconfirm
            title={m.confirmEnable(row.scope, row.name)}
            okText={m.confirm}
            cancelText={m.cancel}
            disabled={locked}
            onConfirm={() => void run('enable')}
          >
            <Button type="link" size="small" disabled={locked}>
              {m.enable}
            </Button>
          </Popconfirm>
        )}
        {actions.references && (
          <Dropdown
            trigger={['click']}
            menu={{ items: [{ key: 'references', label: m.references }], onClick: references }}
          >
            <Button type="link" size="small">
              {m.more}
            </Button>
          </Dropdown>
        )}
      </Space>
      <CommandStatus submission={form} />
    </Space>
  );
}

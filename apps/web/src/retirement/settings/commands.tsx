import type { RetirementRulePurpose } from '@italent/domain';
import { Button, Popconfirm, Space, message } from 'antd';
import { useApiClient } from '../../foundation/Session.js';
import { CommandStatus } from '../../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../../foundation/forms/ConflictCommands.js';
import { slotKey } from '../../foundation/forms/slot.js';
import { createFormStore } from '../../foundation/forms/store.js';
import { s } from './messages.js';
import { formValues, listPath, parseRules, rulesPath, saveReceipt, type Rule, type RuleAccess } from './model.js';

// 路径切换可重建页面。恢复槽仍按会话与规则资源加对象标识隔离（F-123）。
export const settingsStore = createFormStore();

type Action = 'create' | 'edit' | 'toggle' | 'remove';
export function useRuleCommand(purpose: RetirementRulePurpose, action: Action, row?: Rule) {
  const api = useApiClient();
  const current = row
    ? { id: row.id, revision: row.revision, values: formValues(purpose, row) }
    : { revision: 0, values: formValues(purpose) };
  const read = row
    ? async () => {
        const items = parseRules(await api.request<unknown>(listPath(purpose)), purpose);
        const latest = items.find((item) => item.id === row.id);
        if (!latest) throw new Error(s.missingRule);
        return { id: latest.id, revision: latest.revision, values: formValues(purpose, latest) };
      }
    : undefined;
  return useConflictCommand(rulesPath, current, read, { action, purpose });
}

type RowAction = 'copy' | 'toggle' | 'remove';
function RowCommand({
  row,
  writer,
  action,
  reload,
}: {
  row: Rule;
  writer: ReturnType<typeof useRuleCommand>;
  action: RowAction;
  reload(): void;
}) {
  const api = useApiClient();
  const path = slotKey(rulesPath, row.id);
  const remove = action === 'remove';
  const enabled = !row.enabled;
  const values = action === 'toggle' ? { enabled } : {};
  const operations = {
    copy: { path: `${path}/copy`, method: 'POST', label: s.copy, done: s.copied },
    toggle: { path: `${path}/enabled`, method: 'PUT', label: enabled ? s.enable : s.disable, done: s.saved },
    remove: { path, method: 'DELETE', label: s.remove, done: s.removed },
  } as const;
  const operation = operations[action];
  const { label } = operation;
  const locked = writer.form.locked || writer.invalid;
  const run = async () => {
    if (locked) return;
    try {
      await writer.run({
        values,
        editableFields: Object.keys(values),
        deletion: remove,
        send: async ({ command }) => {
          const raw = await api.request<unknown>(operation.path, {
            method: operation.method,
            command: { ...command, body: values },
          });
          if (!remove)
            return saveReceipt(
              raw,
              row.purpose,
              command.revision,
              action === 'copy' ? { copiedFrom: row.id, enabled: false } : { id: row.id, enabled },
            );
          const receipt = raw as { id?: string; deleted?: boolean } | null;
          if (receipt?.id !== row.id || receipt.deleted !== true) throw new Error(s.invalidReceipt);
          return { id: row.id };
        },
      });
      void message.success(operation.done);
      reload();
    } catch {
      // 内核持有拒绝、冲突和结果未知，刷新整表会提前卸载差异核对。
    }
  };
  return (
    <>
      <Popconfirm
        title={s.actionTitle(label, row.name)}
        okText={s.confirm}
        cancelText={s.cancel}
        disabled={locked}
        onConfirm={run}
      >
        <Button type="link" danger={remove} disabled={locked}>
          {label}
        </Button>
      </Popconfirm>
      {!!writer.form.state && <CommandStatus submission={writer.form} labels={s.fields} />}
    </>
  );
}

export function RuleActions({
  row,
  access,
  edit,
  reload,
}: {
  row: Rule;
  access: RuleAccess;
  edit(): void;
  reload(): void;
}) {
  const toggle = useRuleCommand(row.purpose, 'toggle', row);
  const remove = useRuleCommand(row.purpose, 'remove', row);
  // 复制是一条新规则（If-Match 0）。把来源放进命令上下文，避免其他行误显示这次复制的状态。
  const copier = useConflictCommand(rulesPath, { revision: 0, values: {} }, undefined, {
    action: 'copy',
    purpose: row.purpose,
    sourceId: row.id,
  });
  return (
    <Space size={4} wrap>
      {access.edit && !row.preset && (
        <Button type="link" onClick={edit}>
          {s.edit}
        </Button>
      )}
      {access.copy && <RowCommand row={row} writer={copier} action="copy" reload={reload} />}
      {access.toggle && <RowCommand row={row} writer={toggle} action="toggle" reload={reload} />}
      {access.remove && !row.preset && <RowCommand row={row} writer={remove} action="remove" reload={reload} />}
    </Space>
  );
}

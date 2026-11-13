// 矩阵头部的新建 / 编辑弹窗，经 F-123 内核 useConflictCommand + FormOverlay（同 employment-types/TypeCommands.tsx）。
// 原站编辑弹窗：名称（必填）、编码（必填，编辑时只读）、状态、描述（≤255 字）。状态在复刻里由启停按钮改，编辑时只读。
import { Input, Radio } from 'antd';
import type { ReactNode } from 'react';
import type { Command } from '../../foundation/client.js';
import { FormOverlay, type FormField } from '../../foundation/FormOverlay.js';
import { useApiClient } from '../../foundation/Session.js';
import { useConflictCommand } from '../../foundation/forms/ConflictCommands.js';
import type { Values } from '../../foundation/forms/store.js';
import { changedFields, projectFields } from '../../foundation/forms/values.js';
import { m } from './messages.js';
import {
  MATRICES,
  codeError,
  descriptionError,
  descriptionValue,
  matrixPath,
  nameError,
  nameValue,
  parseHead,
  parseReceipt,
  type MatrixHead,
  type MatrixStatus,
} from './model.js';

export const headLabels: Record<string, string> = {
  name: m.name,
  code: m.code,
  status: m.status,
  description: m.description,
};
const EDITABLE = ['name', 'description'];
export const headSnapshot = (head: MatrixHead) => ({
  id: head.id,
  revision: head.revision,
  values: projectFields(head as unknown as Values, EDITABLE),
});
/** 重读单条详情（回查原单 / 冲突重读共用）。 */
export function useHeadRead(head?: MatrixHead) {
  const api = useApiClient();
  if (!head) return undefined;
  return async () => headSnapshot(parseHead(await api.request<unknown>(matrixPath(head.id))));
}
const check = (error: (value: unknown) => string | undefined) => ({
  validator: async (_: unknown, value: unknown) => {
    const message = error(value);
    if (message) throw new Error(message);
  },
});
/** 提交前规范化：名称去首尾空格；描述全空白按未填（null）。 */
const normalize = (values: Values): Values => ({
  ...values,
  ...('name' in values ? { name: nameValue(values.name) } : {}),
  ...('description' in values ? { description: descriptionValue(values.description) } : {}),
});
function bodyOf(command: Command<Values>, id?: string) {
  const body = normalize(command.body);
  if (id) return { ...body, revision: command.revision };
  return { name: body.name, code: body.code, description: body.description ?? null, enable: body.status === 'enabled' };
}

export function HeadForm(props: {
  head?: MatrixHead;
  close(): void;
  saved(receipt?: { id: string; status: MatrixStatus }): void;
}) {
  const { head, close, saved } = props;
  const api = useApiClient();
  const writer = useConflictCommand(
    MATRICES,
    head ? headSnapshot(head) : { revision: 0, values: {} },
    useHeadRead(head),
    head ? { action: 'edit' } : {},
  );
  const field = (name: string, control: ReactNode, rules: FormField['rules'], editable = true): FormField => ({
    name,
    label: headLabels[name]!,
    control,
    access: { visible: true, editable },
    rules,
    requiredMark: name === 'name' || name === 'code',
    display: editable ? undefined : name === 'code' ? head?.code : m.statusLabel[head?.status ?? ''],
  });
  const statusOptions = [
    { value: 'draft', label: m.statusLabel.draft },
    { value: 'enabled', label: m.statusLabel.enabled },
  ];
  const fields = [
    field('name', <Input />, [check(nameError)]),
    field('code', <Input />, [check(codeError)], !head),
    field('status', <Radio.Group options={statusOptions} />, [], !head),
    field('description', <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} />, [check(descriptionError)]),
  ];
  const editable = fields.filter((item) => item.access.editable).map((item) => item.name);
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={head ? matrixPath(head.id) : MATRICES}
      submission={writer.form}
      title={head ? m.editTitle : m.create}
      initialValues={head ? projectFields(head as unknown as Values, EDITABLE) : { status: 'draft', description: '' }}
      groups={[{ title: m.basic, fields }]}
      onClose={() => {
        // 冲突或结果未知时关掉：刷新列表回查（DEC-067）；结果未知的命令仍钉在原单槽上、保持锁定。
        if (writer.stale) saved();
        close();
      }}
      onSubmit={async (raw) => {
        const values = normalize(raw);
        if (head && !changedFields(values, writer.full, editable).length) return writer.form.clear();
        let receipt: { id: string; status: MatrixStatus } | undefined;
        await writer.run({
          values,
          editableFields: editable,
          send: async ({ command }) => {
            const path = head ? matrixPath(head.id) : MATRICES;
            const method = head ? 'PATCH' : 'POST';
            const sent = await api.request<unknown>(path, {
              method,
              command: { ...command, body: bodyOf(command, head?.id) },
            });
            receipt = parseReceipt(sent, { id: head?.id, revision: command.revision ?? 0 });
            return receipt;
          },
        });
        saved(receipt);
      }}
    />
  );
}

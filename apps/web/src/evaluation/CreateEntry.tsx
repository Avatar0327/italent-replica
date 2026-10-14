import { useState, type ReactNode } from 'react';
import { Alert, Button, Descriptions, Modal } from 'antd';
import { FormCommands, useCommandForm } from '../foundation/forms/useCommandForm.js';
import { m } from './messages.js';

export const CreateCommands = FormCommands;

/** 全部创建表单共用此入口；记录在页面 Provider 中，页签、详情和表单卸载不会丢掉保护。 */
export function CreateEntry({
  path,
  title,
  close,
  children,
}: {
  path: string;
  title: string;
  close(): void;
  children: ReactNode;
}) {
  const submission = useCommandForm(path);
  const state = submission.state;
  const pending = state && ['submitting', 'unknown'].includes(state.status) ? state : undefined;
  const [openedPending] = useState(!!pending);
  if (pending && (openedPending || pending.status === 'unknown'))
    return (
      <Modal open title={title} onCancel={close} footer={<Button onClick={close}>{m.cancel}</Button>}>
        <Alert type="info" showIcon message={pending.status === 'submitting' ? m.createPending : m.createUnknown} />
        <Descriptions
          column={1}
          items={[
            { key: 'object', label: m.createObject, children: title },
            {
              key: 'summary',
              label: m.createSummary,
              children: String(pending.values.name ?? pending.values.personId ?? m.noValue),
            },
            { key: 'command', label: m.commandId, children: pending.command?.id },
          ]}
        />
      </Modal>
    );
  return <>{children}</>;
}

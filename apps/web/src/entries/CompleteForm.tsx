import { Button, Input, Space } from 'antd';
import { useEffect, useState } from 'react';
import { FormOverlay } from '../foundation/FormOverlay.js';
import { PageState } from '../foundation/PageState.js';
import { useApiClient } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import type { Values } from '../foundation/forms/values.js';
import { collection, completeBody, editable, emailText, readEntry, receipt, type Row } from './model.js';
import { initial, refreshAfter, request, requireWrite, useEntryAccess, useEntryCommand } from './commands.js';
import { titleExtra, useCompleteGroups } from './CompleteFields.js';
import { m } from './messages.js';

export function CompleteLoader(props: { row: Row; onClose(): void; refresh(): Promise<void> }) {
  const api = useApiClient();
  const [result, setResult] = useState<{ data?: Values; error?: unknown }>();
  useEffect(() => {
    let active = true;
    void readEntry(api, props.row).then(
      (data) => active && setResult({ data }),
      (error: unknown) => active && setResult({ error }),
    );
    return () => {
      active = false;
    };
  }, [api, props.row]);
  if (!result?.data)
    return <PageState kind={result?.error ? 'error' : 'loading'} error={result?.error} retry={props.onClose} />;
  return <CompleteForm {...props} data={result.data} />;
}
function CompleteForm({
  row,
  data,
  onClose,
  refresh,
}: {
  row: Row;
  data: Values;
  onClose(): void;
  refresh(): Promise<void>;
}) {
  const api = useApiClient();
  const permission = useEntryAccess();
  const cmd = useEntryCommand(row, 'complete', initial(data, editable));
  const mail = useEntryCommand(row, 'email', data);
  const [trial, setTrial] = useState(cmd.form.state?.values.probation === true || data.probation === true);
  const email = <EmailField row={row} data={data} />;
  const { groups, fields, create } = useCompleteGroups(cmd.full, permission.edit, trial, setTrial, email);
  return (
    <FormOverlay
      open
      mode="modal"
      className="entry-form"
      title={m.complete}
      titleExtra={titleExtra}
      footerExtra={<Button disabled>{m.draft}</Button>}
      recordKey={row.id}
      submission={mail.form.state && mail.form.locked ? mail.form : cmd.form}
      groups={groups}
      initialValues={initial(data, editable)}
      onClose={onClose}
      onSubmit={async (values) => {
        requireWrite(permission.edit);
        await cmd.run(values, fields, async (command) => {
          const body = completeBody(command.body, String(cmd.full.effectiveDate), create ? fields : []);
          receipt(
            await request(api, `${collection}/${row.id}/complete`, { method: 'POST', command: { ...command, body } }),
            row,
            command,
            'complete',
          );
          await refreshAfter(refresh);
        });
      }}
    />
  );
}
function EmailField({ row, data }: { row: Row; data: Values }) {
  const api = useApiClient();
  const permission = useEntryAccess();
  const cmd = useEntryCommand(row, 'email', data);
  const [text, setText] = useState('');
  const result = m.emailResults[text as keyof typeof m.emailResults] ?? text;
  return (
    <Space direction="vertical">
      <Space>
        <Input disabled value={result} />
        <Button
          type="link"
          disabled={!permission.edit || cmd.form.locked}
          loading={cmd.form.busy}
          onClick={() =>
            void cmd
              .run({}, [], async (command) => {
                const text = emailText(
                  await request(api, `${collection}/${row.id}/generate-email`, { method: 'POST', command }),
                );
                setText(text);
              })
              .catch(() => {})
          }
        >
          {m.email}
        </Button>
      </Space>
      {result && <span>{result}</span>}
      {!cmd.form.locked && <CommandStatus submission={cmd.form} />}
    </Space>
  );
}

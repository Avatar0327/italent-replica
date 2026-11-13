import { Alert, Button, Checkbox, Form, Input, Modal, Space } from 'antd';
import { useState } from 'react';
import { PAGE_CATALOG, type PageDefinition } from '@italent/domain';
import { rejectionMessage } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock } from '../foundation/forms/FormLock.js';
import type { ProfileDetail } from './object-dialog-model.js';
import { pageState } from './page-permission-model.js';
import { pageAppName, pm } from './page-messages.js';
import { usePagePermissionDialog } from './usePagePermissionDialog.js';

export function PagePermissionDialog({
  profile,
  objectCode,
  remove,
  editable,
  close,
  saved,
}: {
  profile: ProfileDetail;
  objectCode: string;
  remove?: string;
  editable: boolean;
  close(): void;
  saved(): void;
}) {
  const editor = usePagePermissionDialog(profile, objectCode, remove, editable, saved);
  const values = Form.useWatch((values) => values, { form: editor.form, preserve: true }) ?? editor.initial;
  const pages = PAGE_CATALOG.filter((p) => p.carrierObject === objectCode);
  const candidates = pages.filter((p) => !pageState(editor.current, p).granted);
  const canSubmit = remove !== undefined || candidates.some((p) => values[p.pageCode] === true);
  const labels = Object.fromEntries(pages.map((p) => [p.pageCode, p.name]));
  const state = editor.command.state;
  return (
    <Modal
      open
      centered
      title={remove ? pm.removeTitle : pm.addTitle}
      onCancel={close}
      closable={!editor.command.busy}
      maskClosable={!editor.command.busy}
      keyboard={!editor.command.busy}
      footer={
        <Space>
          <Button onClick={close} disabled={editor.command.busy}>
            {pm.cancel}
          </Button>
          {state?.status === 'unknown' && editable && (
            <Button onClick={() => void editor.replay()} disabled={!state.latest || !!state.readError || state.reading}>
              {pm.replay}
            </Button>
          )}
          {editable && (
            <Button
              type="primary"
              disabled={editor.locked || !canSubmit}
              loading={editor.command.busy}
              onClick={() => void editor.submit()}
            >
              {pm.confirm}
            </Button>
          )}
        </Space>
      }
    >
      <CommandStatus submission={editor.command} labels={labels} />
      {!!editor.error && <ReadError error={editor.error} loading={editor.loading} reload={editor.reload} />}
      {remove && <Alert type="warning" message={pm.removeHint} description={labels[remove]} />}
      <FormLock locked={editor.locked}>
        <Form form={editor.form} initialValues={editor.initial} disabled={editor.locked}>
          {!remove && (
            <PageCandidates
              app={pages[0]!.appCode}
              current={editor.current}
              candidates={candidates}
              locked={editor.locked}
            />
          )}
        </Form>
      </FormLock>
    </Modal>
  );
}

function PageCandidates({
  app,
  current,
  candidates,
  locked,
}: {
  app: string;
  current: ProfileDetail;
  candidates: readonly PageDefinition[];
  locked: boolean;
}) {
  const [query, setQuery] = useState('');
  const matches = candidates.filter((p) => `${p.name}\n${p.pageCode}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <Input
        aria-label={pm.search}
        placeholder={pm.search}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <h3>{pageAppName(app)}</h3>
      {matches.map((page) => {
        const missingApp = pageState(current, page).missingApp;
        return (
          <div key={page.pageCode}>
            <Form.Item name={page.pageCode} valuePropName="checked">
              <Checkbox disabled={locked || missingApp}>
                {page.name}（{page.pageCode}）
              </Checkbox>
            </Form.Item>
            {missingApp && <p>{pm.needsApp(pageAppName(page.appCode))}</p>}
          </div>
        );
      })}
      {!matches.length && <p>{pm.noCandidates}</p>}
    </>
  );
}

function ReadError({ error, loading, reload }: { error: unknown; loading: boolean; reload(): Promise<void> }) {
  const action = (
    <Button onClick={() => void reload()} loading={loading}>
      {pm.refresh}
    </Button>
  );
  return <Alert type="error" message={rejectionMessage(error)} action={action} />;
}

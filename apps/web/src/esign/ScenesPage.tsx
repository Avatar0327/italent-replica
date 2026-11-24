import { ESIGN_NOTICE_TEMPLATES } from '@italent/domain';
import { Button, Input, Radio, Table, type TableColumnsType } from 'antd';
import { useState } from 'react';
import { useRead } from '../contracts/useRead.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { createFormStore } from '../foundation/forms/store.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import { changedFields } from '../foundation/forms/values.js';
import { m } from './messages.js';
import {
  ESIGN_SETTINGS_OBJECT,
  scenePath,
  integerOf,
  parseScene,
  parseSceneReceipt,
  settingsActions,
  validValidityDays,
  type SceneRow,
  type SignScene,
} from './model.js';
import { sceneText } from './sign-model.js';

const s = m.scenes;
const store = createFormStore();
const snapshotOf = (scene: SceneRow) => ({
  id: scene.scene,
  revision: scene.revision,
  values: { validityDays: scene.validityDays, remindBeforeExpiry: scene.remindBeforeExpiry },
});
const days = (scene: SceneRow) => (scene.validityDays === undefined ? m.missing : s.days(scene.validityDays));
const remind = (scene: SceneRow) => {
  if (scene.remindBeforeExpiry === undefined) return m.missing;
  return scene.remindBeforeExpiry ? s.yes : s.no;
};

export function ScenesPage() {
  const session = useSession();
  return (
    <FormCommands store={store}>
      <SceneList key={JSON.stringify([session.tenantId, session.identityKey, session.userId])} />
    </FormCommands>
  );
}

function useScene(kind: SignScene) {
  const read = useRead<unknown>(scenePath(kind));
  try {
    const row = read.data === undefined ? undefined : parseScene(read.data, kind);
    return { ...read, kind, row };
  } catch (error) {
    return { ...read, kind, error, row: undefined };
  }
}

function SceneList() {
  const permission = usePermissions(ESIGN_SETTINGS_OBJECT);
  const actions = settingsActions(permission.snapshot.objects[ESIGN_SETTINGS_OBJECT]);
  const transfer = useScene('transfer');
  const offer = useScene('offer');
  const entry = useScene('entry');
  const scenes = [transfer, offer, entry];
  const rows = scenes.flatMap(({ row }) => (row ? [row] : []));
  const [editing, setEditing] = useState<SignScene>();
  const selected = scenes.find(({ kind }) => kind === editing);
  const columns: TableColumnsType<SceneRow> = [
    { key: 'scene', title: s.scene, render: (_, row) => sceneText(row.scene) },
    { key: 'application', title: s.application, render: () => s.applicationName },
    { key: 'description', title: s.description, render: (_, row) => s.descriptions[row.scene] },
    { key: 'validityDays', title: s.validityDays, render: (_, row) => days(row) },
    { key: 'remind', title: s.remindBeforeExpiry, render: (_, row) => remind(row) },
  ];
  if (actions.scene)
    columns.push({
      key: 'actions',
      title: m.actions,
      render: (_, row) => (
        <Button type="link" size="small" onClick={() => setEditing(row.scene)}>
          {m.edit}
        </Button>
      ),
    });
  return (
    <section className="esign-scenes">
      <header className="page-heading">
        <h1>{s.title}</h1>
      </header>
      {scenes.map(({ kind, error, refresh }) =>
        error ? (
          <section key={kind} aria-label={sceneText(kind)}>
            <PageState kind="error" error={error} retry={refresh} />
          </section>
        ) : null,
      )}
      {!rows.length && scenes.some(({ loading }) => loading) && <PageState kind="loading" />}
      {!!rows.length && (
        <Table<SceneRow> size="small" rowKey="scene" dataSource={rows} pagination={false} columns={columns} />
      )}
      {selected?.row && actions.scene && (
        <SceneForm scene={selected.row} close={() => setEditing(undefined)} saved={selected.refresh} />
      )}
    </section>
  );
}

const readonly = { visible: true, editable: false };
const fixedFields = (scene: SignScene): FormField[] => [
  { name: 'flow', label: s.flow, control: null, access: readonly, display: s.flowNodes },
  { name: 'confirmMethod', label: s.confirmMethod, control: null, access: readonly, display: s.confirmMethodValue },
  {
    name: 'notices',
    label: s.notices,
    control: null,
    access: readonly,
    display: (
      <div>
        <div>{s.noticesChannel}</div>
        <ul className="esign-notice-list">
          {Object.entries(ESIGN_NOTICE_TEMPLATES).map(([code, notice]) => (
            <li key={code}>
              {scene === 'transfer'
                ? s.noticeLine(notice.title, s.receivers[code] ?? m.missing, notice.body)
                : s.noticeRecipient(notice.title, s.receivers[code] ?? m.missing)}
            </li>
          ))}
        </ul>
      </div>
    ),
  },
];

function SceneForm({ scene, close, saved }: { scene: SceneRow; close(): void; saved(): void }) {
  const api = useApiClient();
  const path = scenePath(scene.scene);
  const current = snapshotOf(scene);
  const read = async () => snapshotOf(parseScene(await api.request<unknown>(path), scene.scene));
  const writer = useConflictCommand(path, current, read, { action: 'edit' });
  const fields: FormField[] = [
    {
      name: 'validityDays',
      label: s.validityDays,
      control: <Input inputMode="numeric" />,
      access: { visible: true, editable: true },
      rules: [
        {
          validator: async (_rule: unknown, value: unknown) => {
            if (!validValidityDays(value)) throw new Error(s.validityRange);
          },
        },
      ],
    },
    {
      name: 'remindBeforeExpiry',
      label: s.remindBeforeExpiry,
      control: (
        <Radio.Group
          options={[
            { value: true, label: s.yes },
            { value: false, label: s.no },
          ]}
        />
      ),
      access: { visible: true, editable: true },
      rules: [{ required: true, message: m.templates.required }],
    },
  ];
  const editable = ['validityDays', 'remindBeforeExpiry'];
  return (
    <FormOverlay
      open
      recordKey={path}
      submission={writer.form}
      title={s.editTitle}
      titleExtra={sceneText(scene.scene)}
      initialValues={current.values}
      groups={[
        { title: s.settings, fields },
        { title: `${s.fixedGroup}（${s.fixed}）`, fields: fixedFields(scene.scene) },
      ]}
      onClose={() => {
        if (writer.stale) saved();
        else if (writer.form.status === 'rejected') writer.form.clear();
        close();
      }}
      onSubmit={async (values) => {
        const body = { ...values, validityDays: integerOf(values.validityDays) };
        if (!changedFields(body, writer.full, editable).length) return;
        await writer.run({
          values: body,
          editableFields: editable,
          send: async ({ command }) => {
            // PUT 是整份替换：两项都发，不只发改动项（input.ts sceneSettingsSchema 两项必填）。
            const full: Record<string, unknown> = { ...writer.full, ...body };
            const raw = await api.request<unknown>(path, {
              method: 'PUT',
              command: {
                ...command,
                body: { validityDays: full.validityDays, remindBeforeExpiry: full.remindBeforeExpiry },
              },
            });
            return parseSceneReceipt(raw, scene.scene, command.revision);
          },
        });
        saved();
      }}
    />
  );
}

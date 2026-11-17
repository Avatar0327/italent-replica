// F-481 §5、§8.4：电子签 > 签署场景设置。只有一行“调动电子签署”；可改签署有效期（2～30 天）与到期前自动提醒，
// 签署流程、确认方式、消息设置只读展示固定值（D4、D5）。保存走 PUT /esign/scenes/transfer，带 If-Match（routes.ts）。
import { ESIGN_NOTICE_TEMPLATES, ESIGN_SCENE_LABEL } from '@italent/domain';
import { Button, Input, Radio, Table } from 'antd';
import { useState } from 'react';
import { useRead } from '../contracts/useRead.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { createFormStore } from '../foundation/forms/store.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import { changedFields } from '../foundation/forms/values.js';
import { m } from './messages.js';
import {
  ESIGN_SETTINGS_OBJECT,
  SCENE_PATH,
  integerOf,
  parseScene,
  parseSceneReceipt,
  settingsActions,
  validValidityDays,
  type SceneRow,
} from './model.js';

const s = m.scenes;
const store = createFormStore();
const snapshotOf = (scene: SceneRow) => ({
  id: 'transfer',
  revision: scene.revision,
  values: { validityDays: scene.validityDays, remindBeforeExpiry: scene.remindBeforeExpiry },
});
const days = (scene: SceneRow) => (scene.validityDays === undefined ? m.missing : s.days(scene.validityDays));
const remind = (scene: SceneRow) => {
  if (scene.remindBeforeExpiry === undefined) return m.missing;
  return scene.remindBeforeExpiry ? s.yes : s.no;
};

export function ScenesPage() {
  return (
    <FormCommands store={store}>
      <SceneList />
    </FormCommands>
  );
}

function SceneList() {
  const permission = usePermissions(ESIGN_SETTINGS_OBJECT);
  const actions = settingsActions(permission.snapshot.objects[ESIGN_SETTINGS_OBJECT]);
  const read = useRead<unknown>(SCENE_PATH);
  const [editing, setEditing] = useState(false);
  let scene: SceneRow | undefined;
  let error = read.error;
  try {
    if (read.data !== undefined) scene = parseScene(read.data);
  } catch (cause) {
    error = cause;
  }
  return (
    <section className="esign-scenes">
      <header className="page-heading">
        <h1>{s.title}</h1>
      </header>
      {!!error && <PageState kind="error" error={error} retry={read.refresh} />}
      {!error && read.loading && <PageState kind="loading" />}
      {scene && !error && !read.loading && (
        <Table<SceneRow>
          size="small"
          rowKey={() => 'transfer'}
          dataSource={[scene]}
          pagination={false}
          columns={[
            { key: 'scene', title: s.scene, render: () => ESIGN_SCENE_LABEL },
            { key: 'application', title: s.application, render: () => s.applicationName },
            { key: 'description', title: s.description, render: () => s.sceneDescription },
            { key: 'validityDays', title: s.validityDays, render: (_: unknown, row: SceneRow) => days(row) },
            { key: 'remind', title: s.remindBeforeExpiry, render: (_: unknown, row: SceneRow) => remind(row) },
            ...(actions.scene
              ? [
                  {
                    key: 'actions',
                    title: m.actions,
                    render: () => (
                      <Button type="link" size="small" onClick={() => setEditing(true)}>
                        {m.edit}
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {editing && scene && <SceneForm scene={scene} close={() => setEditing(false)} saved={read.refresh} />}
    </section>
  );
}

const readonly = { visible: true, editable: false };
const fixedFields: FormField[] = [
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
            <li key={code}>{s.noticeLine(notice.title, s.receivers[code] ?? m.missing, notice.body)}</li>
          ))}
        </ul>
      </div>
    ),
  },
];

function SceneForm({ scene, close, saved }: { scene: SceneRow; close(): void; saved(): void }) {
  const api = useApiClient();
  const current = snapshotOf(scene);
  const read = async () => snapshotOf(parseScene(await api.request<unknown>(SCENE_PATH)));
  const writer = useConflictCommand(SCENE_PATH, current, read, { action: 'edit' });
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
      recordKey={SCENE_PATH}
      submission={writer.form}
      title={s.editTitle}
      initialValues={current.values}
      groups={[
        { title: s.settings, fields },
        { title: `${s.fixedGroup}（${s.fixed}）`, fields: fixedFields },
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
            const raw = await api.request<unknown>(SCENE_PATH, {
              method: 'PUT',
              command: {
                ...command,
                body: { validityDays: full.validityDays, remindBeforeExpiry: full.remindBeforeExpiry },
              },
            });
            return parseSceneReceipt(raw, command.revision ?? 0);
          },
        });
        saved();
      }}
    />
  );
}

import { Alert, Button, Input, InputNumber, Popconfirm, Switch, Table, Tabs, Tag } from 'antd';
import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { successionDemo } from '../demo-stubs/succession.js';
import { CreateCommands } from '../evaluation/CreateEntry.js';
import { Failure, useRead } from '../evaluation/runtime.js';
import { useRecordForm } from '../evaluation/useRecordForm.js';
import type { Row } from '../evaluation/model.js';
import { newCommand } from '../foundation/client.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { ListPage } from '../foundation/templates.js';
import { s } from './messages.js';
import { BASE, READINESS_PATH } from './rules.js';
import './succession.css';

type Kind = 'risk' | 'health' | 'readiness';
interface Dictionary {
  path: string;
  object: string;
  order: 'displayOrder' | 'sortNo';
  update: 'PUT' | 'PATCH';
}
const dictionaries: Record<Kind, Dictionary> = {
  risk: { path: `${BASE}/risk-levels`, object: 'Succession.RiskLevel', order: 'displayOrder', update: 'PUT' },
  health: { path: `${BASE}/health-levels`, object: 'Succession.HealthLevel', order: 'displayOrder', update: 'PUT' },
  // 准备度归人才盘点（DEC-301①）：同一字典，接口与权限对象都用人才盘点的。
  readiness: { path: READINESS_PATH, object: 'TalentReview.Readiness', order: 'sortNo', update: 'PATCH' },
};

export function SuccessionSettingsPage() {
  const { section } = useParams();
  const navigate = useNavigate();
  const back = (
    <Button className="succession-back" onClick={() => void navigate('/succession/manage')}>
      {s.settings.back}
    </Button>
  );
  return (
    <CreateCommands>
      <div className="succession-page">
        {back}
        {section === 'map' ? (
          <MapSettings />
        ) : section === 'key-positions' ? (
          <KeyPositions />
        ) : section === 'readiness' ? (
          <>
            <DecisionNote id="succession-readiness" />
            <DictionaryList kind="readiness" />
          </>
        ) : (
          <PageState kind="not-found" />
        )}
      </div>
    </CreateCommands>
  );
}

function MapSettings() {
  const { snapshot } = usePermissions();
  const [active, setActive] = useState('display');
  const items = [
    { key: 'display', label: s.settings.display, children: <DisplaySettings /> },
    ...(['risk', 'health'] as const)
      .filter((kind) => !!snapshot.objects[dictionaries[kind].object])
      .map((kind) => ({ key: kind, label: s.settings[kind], children: <DictionaryList kind={kind} /> })),
  ];
  return (
    <>
      <DecisionNote id="succession-map-settings" />
      <Tabs activeKey={active} onChange={setActive} items={items} destroyOnHidden />
    </>
  );
}

export function DemoNotice() {
  return (
    <Alert
      type="info"
      showIcon
      message={
        <>
          <Tag color="gold">{s.demo}</Tag>
          {s.demoNotice}
        </>
      }
    />
  );
}

/** 卡片字段配置后端未提供（后端缺口清单）：只读演示，不写任何数据。 */
function DisplaySettings() {
  return (
    <section className="list-card">
      <DemoNotice />
      <Table
        rowKey="key"
        pagination={false}
        dataSource={successionDemo.cardFields}
        columns={[
          { key: 'target', dataIndex: 'target', title: s.settings.cardFields },
          {
            key: 'fields',
            title: s.settings.name,
            render: (_, row) => row.fields.map((field) => <Tag key={field}>{field}</Tag>),
          },
        ]}
      />
    </section>
  );
}

function KeyPositions() {
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  return (
    <>
      <DecisionNote id="succession-key-positions" />
      <DemoNotice />
      <ListPage
        title={s.menu.keyPositions}
        view={{ value: 'enabled', options: [{ key: 'enabled', label: s.key.view }], onChange: () => undefined }}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        data={{ items: successionDemo.keyPositions, total: successionDemo.keyPositions.length }}
        columns={(['name', 'category', 'org', 'downward', 'enabled', 'createdAt'] as const).map((key) => ({
          key,
          dataIndex: key,
          title: s.key[key],
        }))}
      />
    </>
  );
}

const title = (kind: Kind) => s.settings.titles[kind]!;
/** 三类等级字典共用：列表、新建、编辑、删除；规则条件与重排不在本页编辑（docs/02_业务建模/27 §5.9）。 */
function DictionaryList({ kind }: { kind: Kind }) {
  const dictionary = dictionaries[kind];
  const permission = usePermissions(dictionary.object);
  const api = useApiClient();
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const list = useRead<{ items: Row[]; total?: number }>(
    `${dictionary.path}?page=${page.page}&pageSize=${page.pageSize}`,
  );
  const [editing, setEditing] = useState<Row | 'new'>();
  const [error, setError] = useState<unknown>();
  const remove = async (row: Row) => {
    setError(undefined);
    try {
      await api.request(`${dictionary.path}/${row.id}`, {
        method: 'DELETE',
        command: newCommand(undefined, row.revision),
      });
      list.reload();
    } catch (cause) {
      setError(cause);
    }
  };
  const columns = dictionaryColumns(kind, permission, setEditing, remove);
  return (
    <>
      <Failure error={error} />
      <ListPage<Row>
        title={title(kind)}
        rowKey="id"
        data={{ items: list.data?.items ?? [], total: list.data?.total ?? list.data?.items.length ?? 0 }}
        columns={columns}
        page={page}
        onPageChange={setPage}
        loading={list.loading}
        error={list.error}
        retry={list.reload}
        actions={
          permission.can('create', 'list') && (
            <Button type="primary" onClick={() => setEditing('new')}>
              {s.settings.create}
            </Button>
          )
        }
      />
      {kind !== 'readiness' && <p className="succession-muted">{s.settings.rulesReadonly}</p>}
      {editing && (
        <DictionaryForm
          kind={kind}
          row={editing === 'new' ? undefined : editing}
          close={() => setEditing(undefined)}
          saved={list.reload}
        />
      )}
    </>
  );
}

type Access = ReturnType<typeof usePermissions>;
function dictionaryColumns(kind: Kind, permission: Access, edit: (row: Row) => void, remove: (row: Row) => void) {
  const order = dictionaries[kind].order;
  const columns = [
    {
      key: 'order',
      field: order,
      title: s.settings.order,
      render: (row: Row) => String(row[order] ?? s.none),
    },
    {
      key: 'name',
      field: 'name',
      title: kind === 'readiness' ? s.settings.stage : s.settings.name,
      render: (row: Row) =>
        permission.can('update') ? (
          <Button type="link" onClick={() => edit(row)}>
            {row.name}
          </Button>
        ) : (
          row.name
        ),
    },
    { key: 'code', field: 'code', title: s.settings.code, render: (row: Row) => String(row.code ?? s.none) },
    {
      key: 'description',
      field: 'description',
      title: s.settings.description,
      render: (row: Row) => String(row.description ?? s.none),
    },
    { key: 'color', field: 'color', title: s.settings.color, render: (row: Row) => <ColorSwatch color={row.color} /> },
    {
      key: 'enabled',
      field: 'enabled',
      title: s.settings.enabled,
      render: (row: Row) => (row.enabled ? s.settings.yes : s.settings.no),
    },
  ]
    .filter((column) => permission.field(column.field).visible)
    .map(({ key, title: text, render }) => ({ key, title: text, render: (_: unknown, row: Row) => render(row) }));
  const actions = permission.can('delete')
    ? [
        {
          key: 'actions',
          title: s.settings.actions,
          render: (_: unknown, row: Row) => (
            <Popconfirm title={s.deleteConfirm} onConfirm={() => remove(row)}>
              <Button type="link" danger>
                {s.delete}
              </Button>
            </Popconfirm>
          ),
        },
      ]
    : [];
  return [...columns, ...actions];
}

const ColorSwatch = ({ color }: { color: unknown }) =>
  typeof color === 'string' ? (
    <span className="succession-color">
      <i style={{ background: color }} />
      {color}
    </span>
  ) : (
    <>{s.none}</>
  );

function DictionaryForm({ kind, row, close, saved }: { kind: Kind; row?: Row; close(): void; saved(): void }) {
  const dictionary = dictionaries[kind];
  const permission = usePermissions(dictionary.object);
  const writer = useRecordForm(dictionary.path, row);
  const access = (name: string) => {
    const field = permission.field(name);
    // 编码建后不可改（PATCH / PUT 体都不收 code）。
    return row && name === 'code' ? { ...field, editable: false } : field;
  };
  const required = { required: true, message: s.required };
  const field = (name: string, label: string, control: ReactNode, rules: FormField['rules'] = []): FormField => ({
    name,
    label,
    control,
    access: access(name),
    rules,
  });
  // 长度上限跟服务端一致：准备度 50 / 500，继任等级 100 / 200 / 2000。
  const max =
    kind === 'readiness' ? { code: 50, name: 50, description: 500 } : { code: 100, name: 200, description: 2000 };
  const fields = [
    field('code', s.settings.code, <Input maxLength={max.code} />, [required]),
    field('name', kind === 'readiness' ? s.settings.stage : s.settings.name, <Input maxLength={max.name} />, [
      required,
    ]),
    field('color', s.settings.color, <Input maxLength={7} placeholder="#146EFF" />, [
      required,
      { pattern: /^#[0-9a-fA-F]{6}$/, message: s.settings.colorFormat },
    ]),
    field('description', s.settings.description, <Input.TextArea maxLength={max.description} />),
    ...(kind === 'readiness' ? [field('sortNo', s.settings.order, <InputNumber min={0} precision={0} />)] : []),
    field('enabled', s.settings.enabled, <Switch aria-label={s.settings.enabled} />),
  ];
  const verb = row ? s.edit : s.settings.create;
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={row?.id ?? `new-${kind}`}
      submission={writer}
      title={`${verb}${title(kind)}`}
      initialValues={row ? { ...row } : { enabled: true }}
      groups={[{ title: s.basic, fields }]}
      onClose={close}
      onSubmit={async (values) => {
        const editable = fields.filter((f) => f.access.visible && f.access.editable).map((f) => f.name);
        await writer.save(values, editable, row ? dictionary.update : 'POST', (body) =>
          'description' in body && !body.description ? { ...body, description: null } : body,
        );
        writer.clear();
        saved();
      }}
    />
  );
}

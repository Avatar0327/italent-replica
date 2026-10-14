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
import { BASE, READINESS_PATH, ruleLines } from './rules.js';
import './succession.css';
import type { LevelRules } from './types.js';

type Kind = 'risk' | 'health' | 'readiness' | 'population';
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
  // 人员范围本页只读：规则编辑按范围暂缓（docs/02_业务建模/27 §5.9）。
  population: { path: `${BASE}/populations`, object: 'Succession.Population', order: 'displayOrder', update: 'PUT' },
};

const sections: Record<string, ReactNode> = {
  map: <MapSettings />,
  health: <HealthSettings />,
  'key-positions': <KeyPositions />,
  readiness: (
    <>
      <DecisionNote id="succession-readiness" />
      <DictionaryList kind="readiness" />
    </>
  ),
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
        {sections[section ?? ''] ?? <PageState kind="not-found" />}
      </div>
    </CreateCommands>
  );
}

function MapSettings() {
  const { snapshot } = usePermissions();
  const [active, setActive] = useState('display');
  const items = [
    { key: 'display', label: s.settings.display, children: <DisplaySettings /> },
    ...(snapshot.objects[dictionaries.risk.object]
      ? [{ key: 'risk', label: s.settings.risk, children: <DictionaryList kind="risk" /> }]
      : []),
  ];
  return (
    <>
      <DecisionNote id="succession-map-settings" />
      <Tabs activeKey={active} onChange={setActive} items={items} destroyOnHidden />
    </>
  );
}

/** 健康度规则设置是独立菜单页：人员范围 / 继任地图健康度两个页签（UI2 对照）。 */
function HealthSettings() {
  const { snapshot } = usePermissions();
  const tabs = [
    { key: 'population', label: s.settings.populations },
    { key: 'health', label: s.settings.healthTab },
  ] as const;
  const items = tabs
    .filter((tab) => !!snapshot.objects[dictionaries[tab.key].object])
    .map((tab) => ({ ...tab, children: <DictionaryList kind={tab.key} /> }));
  const [active, setActive] = useState<string>();
  return (
    <>
      <DecisionNote id="succession-health-settings" />
      <Tabs activeKey={active ?? items[0]?.key} onChange={setActive} items={items} destroyOnHidden />
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
  const readonly = kind === 'population';
  return (
    <>
      <Failure error={error} />
      <ListPage<Row>
        title={title(kind)}
        rowKey="id"
        // 准备度接口没有 total：交给模板的无总数分页（满页可点下一页）。
        data={{ items: list.data?.items ?? [], total: list.data?.total }}
        columns={columns}
        page={page}
        onPageChange={setPage}
        loading={list.loading}
        error={list.error}
        retry={list.reload}
        actions={
          !readonly &&
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
      render: (row: Row) => String(row.name ?? s.none),
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
    {
      key: 'rules',
      field: 'rules',
      title: s.settings.rules,
      render: (row: Row) => <RulesView rules={row.rules as LevelRules | null | undefined} />,
    },
  ]
    .filter((column) => columnKeys[kind].includes(column.key))
    .filter((column) => permission.field(column.field).visible)
    .map(({ key, title: text, render }) => ({ key, title: text, render: (_: unknown, row: Row) => render(row) }));
  const canEdit = kind !== 'population' && permission.can('update');
  const canDelete = kind !== 'population' && permission.can('delete');
  const actions =
    canEdit || canDelete
      ? [
          {
            key: 'actions',
            title: s.settings.actions,
            render: (_: unknown, row: Row) => (
              <>
                {canEdit && (
                  <Button type="link" onClick={() => edit(row)}>
                    {s.edit}
                  </Button>
                )}
                {canDelete && (
                  <Popconfirm title={s.settings.deleteConfirm} onConfirm={() => remove(row)}>
                    <Button type="link" danger>
                      {s.delete}
                    </Button>
                  </Popconfirm>
                )}
              </>
            ),
          },
        ]
      : [];
  return [...columns, ...actions];
}

// 原站准备度列表只有排序、阶段、描述、颜色与操作（UI2 对照）；编码仍在表单里，因为后端必填。
const levelColumns = ['order', 'name', 'code', 'description', 'color', 'enabled', 'rules'];
const columnKeys: Record<Kind, string[]> = {
  risk: levelColumns,
  health: levelColumns,
  readiness: ['order', 'name', 'description', 'color'],
  population: ['order', 'name', 'code', 'rules'],
};

/** 规则只读也要显示内容：表达式 + 条件行（接口 rules 原样，枚举换成原站用语）。 */
function RulesView({ rules }: { rules: LevelRules | null | undefined }) {
  const lines = ruleLines(rules);
  if (!lines) return <span className="succession-rules succession-muted">{s.settings.noRules}</span>;
  return (
    <div className="succession-rules">
      {lines.expression && <div>{`${s.settings.expression}：${lines.expression}`}</div>}
      {lines.rows.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
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
    // 准备度原站表单没有启用开关：enabled 可选、后端默认启用，不发即可（编码后端必填，保留）。
    ...(kind === 'readiness'
      ? [field('sortNo', s.settings.order, <InputNumber min={0} precision={0} />)]
      : [field('enabled', s.settings.enabled, <Switch aria-label={s.settings.enabled} />)]),
  ];
  const verb = row ? s.edit : s.settings.create;
  // 新建继任等级默认启用；准备度不带启用项（见上）。
  const blank = kind === 'readiness' ? {} : { enabled: true };
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={row?.id ?? `new-${kind}`}
      submission={writer}
      title={`${verb}${title(kind)}`}
      initialValues={row ? { ...row } : blank}
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

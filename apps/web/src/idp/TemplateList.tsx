import { Button, Form, Input, Modal, Popconfirm, Space, type TableColumnsType } from 'antd';
import { useMemo, useState, type ReactNode } from 'react';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { usePermissions } from '../foundation/Permissions.js';
import { ListPage } from '../foundation/templates.js';
import { IDP_API, OBJECTS, useAction, useCollection } from './api.js';
import { ActionError, HeaderActions, NameSearch, useLocalPage, yesNo } from './listing.js';
import { t } from './messages.js';
import { display } from './model.js';
import { TemplateDetailDrawer } from './TemplateDetail.js';
import { TemplateForm } from './TemplateForm.js';
import type { Process, Template } from './types.js';
import { useNames } from './useNames.js';

type View = 'published' | 'draft';
const VIEW_OPTIONS = [
  { key: 'published', label: t.views.enabledTemplates },
  { key: 'draft', label: t.views.disabledTemplates },
];
type RowAction = 'update' | 'copy' | 'publish' | 'unpublish' | 'delete';
/** 模板行动作均为详情级按钮（IDP_OBJECTS.template）；启用 / 停用按当前状态二选一。 */
const ACTIONS: readonly RowAction[] = ['update', 'copy', 'publish', 'unpublish', 'delete'];
const CONFIRMS: Partial<Record<RowAction, string>> = {
  publish: t.confirm.publish,
  unpublish: t.confirm.unpublish,
  delete: t.confirm.delete,
};
const applies = (row: Template, key: RowAction) =>
  key === 'publish' ? row.status === 'draft' : key === 'unpublish' ? row.status === 'published' : true;

export function TemplateList() {
  const permission = usePermissions(OBJECTS.template);
  const list = useCollection<Template>(`${IDP_API}/templates`);
  const processes = useCollection<Process>(`${IDP_API}/processes`);
  const [view, setView] = useState<View>('published');
  const [name, setName] = useState('');
  const [openId, setOpenId] = useState<string>();
  const [editing, setEditing] = useState<{ template?: Template }>();
  const [copying, setCopying] = useState<Template>();
  // 写入后详情按新代次重读，避免抽屉继续展示旧 revision
  const [version, setVersion] = useState(0);
  const refresh = () => {
    setVersion((value) => value + 1);
    list.reload();
  };
  const rows = useMemo(
    () => (list.items ?? []).filter((row) => row.status === view && (row.name ?? '').includes(name.trim())),
    [list.items, view, name],
  );
  const paging = useLocalPage(rows, list.loading);
  const orgIds = paging.shown.map((row) => row.orgId);
  const orgs = useNames('org', orgIds);
  const processName = (id?: string) => (id ? (processes.items?.find((item) => item.id === id)?.name ?? id) : t.noValue);
  const { action, operations } = useOperations(permission.can, refresh, {
    update: (row) => setEditing({ template: row }),
    copy: setCopying,
    deleted: () => setOpenId(undefined),
  });
  return (
    <>
      <DecisionNote id="idp-templates" />
      {!!action.error && <ActionError error={action.error} reset={action.blocked && action.reset} />}
      <ListPage<Template>
        title={t.templates}
        view={{
          value: view,
          options: VIEW_OPTIONS,
          onChange: (value) => {
            setView(value as View);
            paging.first();
          },
        }}
        data={{ items: paging.shown, total: rows.length, hasDataPermission: list.hasDataPermission }}
        columns={columns(permission.field, orgs, processName, setOpenId, operations)}
        rowKey="id"
        page={paging.page}
        onPageChange={paging.change}
        loading={list.loading}
        error={list.error}
        retry={list.reload}
        filters={
          permission.field('name').visible && (
            <NameSearch
              value={name}
              change={(value) => {
                setName(value);
                paging.first();
              }}
            />
          )
        }
        actions={
          <HeaderActions create={permission.can('create', 'list') && (() => setEditing({}))} refresh={refresh} />
        }
      />
      {openId && (
        <TemplateDetailDrawer
          key={`${openId}/${version}`}
          id={openId}
          processName={processName}
          orgName={orgs}
          actions={operations}
          onClose={() => setOpenId(undefined)}
        />
      )}
      {editing && <TemplateForm template={editing.template} close={() => setEditing(undefined)} saved={refresh} />}
      {copying && <CopyDialog source={copying} close={() => setCopying(undefined)} done={refresh} />}
    </>
  );
}

/** 行 / 详情操作：编辑、复制走弹窗，其余直接带 revision 提交；启用 / 停用按当前状态二选一。 */
function useOperations(
  can: (action: string, level: 'detail') => boolean,
  refresh: () => void,
  open: { update(row: Template): void; copy(row: Template): void; deleted(): void },
) {
  const action = useAction(refresh);
  const perform = async (row: Template, key: RowAction) => {
    if (key === 'update' || key === 'copy') return open[key](row);
    const path = `${IDP_API}/templates/${row.id}${key === 'delete' ? '' : `/${key}`}`;
    const done = await action.run(path, key === 'delete' ? 'DELETE' : 'POST', {}, row.revision!);
    if (done !== undefined && key === 'delete') open.deleted();
  };
  const operations = (row: Template) => (
    <RowButtons
      row={row}
      keys={ACTIONS.filter((key) => can(key, 'detail') && row.revision !== undefined && applies(row, key))}
      busy={action.busy || action.blocked}
      perform={perform}
    />
  );
  return { action, operations };
}

function RowButtons(props: {
  row: Template;
  keys: RowAction[];
  busy: boolean;
  perform(row: Template, key: RowAction): void;
}) {
  const { row, keys, busy, perform } = props;
  return (
    <Space size={4}>
      {keys.map((key) => {
        const label = key === 'update' ? t.actions.edit : t.actions[key];
        return CONFIRMS[key] ? (
          <Popconfirm key={key} title={CONFIRMS[key]} onConfirm={() => perform(row, key)}>
            <Button type="link" disabled={busy}>
              {label}
            </Button>
          </Popconfirm>
        ) : (
          <Button key={key} type="link" disabled={busy} onClick={() => perform(row, key)}>
            {label}
          </Button>
        );
      })}
    </Space>
  );
}

function columns(
  field: (name: string) => { visible: boolean },
  orgs: (id?: string | null) => string,
  processName: (id?: string) => string,
  open: (id: string) => void,
  operations: (row: Template) => ReactNode,
): TableColumnsType<Template> {
  const all: (TableColumnsType<Template>[number] | false)[] = [
    field('name').visible && {
      key: 'name',
      title: t.fields.templateName,
      width: 220,
      render: (_, row) => (
        <Button type="link" onClick={() => open(row.id)}>
          {display(row.name)}
        </Button>
      ),
    },
    field('processId').visible && {
      key: 'processId',
      title: t.fields.processId,
      width: 180,
      render: (_, row) => processName(row.processId),
    },
    field('orgId').visible && { key: 'orgId', title: t.fields.orgId, width: 160, render: (_, row) => orgs(row.orgId) },
    field('publicDown').visible && {
      key: 'publicDown',
      title: t.fields.publicDown,
      width: 90,
      render: (_, row) => yesNo(row.publicDown),
    },
    field('description').visible && {
      key: 'description',
      title: t.fields.description,
      width: 200,
      ellipsis: true,
      render: (_, row) => display(row.description),
    },
    { key: 'operations', title: t.fields.operations, fixed: 'right', width: 220, render: (_, row) => operations(row) },
  ];
  return all.filter((column) => !!column) as TableColumnsType<Template>;
}

/** 复制是新建命令（源模板 revision 只作并发校验）；名称必填 1～100。 */
function CopyDialog({ source, close, done }: { source: Template; close(): void; done(): void }) {
  const action = useAction(done);
  const [form] = Form.useForm<{ name: string }>();
  const ok = async () => {
    const values = await form.validateFields();
    const body = { name: values.name.trim() };
    const result = await action.run(`${IDP_API}/templates/${source.id}/copy`, 'POST', body, source.revision!);
    if (result !== undefined) close();
  };
  return (
    <Modal
      open
      title={t.copyTemplate}
      onCancel={close}
      okText={t.actions.ok}
      cancelText={t.actions.back}
      onOk={() => void ok()}
      okButtonProps={{ disabled: action.blocked, loading: action.busy }}
    >
      {!!action.error && <ActionError error={action.error} />}
      <Form form={form} layout="vertical" initialValues={{ name: `${source.name ?? ''}${t.copySuffix}` }}>
        <Form.Item
          name="name"
          label={t.fields.templateName}
          rules={[{ required: true, whitespace: true, max: 100, message: t.required }]}
        >
          <Input maxLength={100} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

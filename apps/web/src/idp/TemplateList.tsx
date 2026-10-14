import { Alert, Button, Form, Input, Space, type TableColumnsType } from 'antd';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { ListPage } from '../foundation/templates.js';
import { IDP_API, OBJECTS, useCollection, useCommand } from './api.js';
import { CommandDialog, CommandNotice, HeaderActions, NameSearch, useLocalPage, yesNo } from './listing.js';
import { t } from './messages.js';
import {
  display,
  statusText,
  templateActions,
  templateInView,
  type TemplateAction,
  type TemplateView,
} from './model.js';
import { TemplateDetailPage } from './TemplateDetail.js';
import { TemplateForm } from './TemplateForm.js';
import type { Process, Template } from './types.js';
import { useNames } from './useNames.js';

const VIEW_OPTIONS = [
  { key: 'published', label: t.views.enabledTemplates },
  { key: 'draft', label: t.views.disabledTemplates },
];
type Confirmable = Exclude<TemplateAction, 'update' | 'copy'>;
const CONFIRMS: Record<Confirmable, string> = {
  publish: t.confirm.publish,
  unpublish: t.confirm.unpublish,
  delete: t.confirm.delete,
};
const DETAIL = 'template';

/** 同一模板的状态动作共用一条命令：结果未知时启用、停用、删除一并锁住，按原单回查后再操作。 */
function useTemplateCommand(id: string) {
  const api = useApiClient();
  return useCommand(`${IDP_API}/templates/${id}:action`, id, (key) =>
    api.request<Template>(`${IDP_API}/templates/${key}`),
  );
}

export function TemplateList() {
  const permission = usePermissions(OBJECTS.template);
  const list = useCollection<Template>(`${IDP_API}/templates`);
  const processes = useCollection<Process>(`${IDP_API}/processes`);
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<TemplateView>('published');
  const [name, setName] = useState('');
  const openId = params.get(DETAIL);
  const open = (id?: string) => setParams(id ? { [DETAIL]: id } : {});
  const overlays = useTemplateOverlays(list.reload, (id) => {
    if (openId === id) open();
  });
  const rows = useMemo(
    () => (list.items ?? []).filter((row) => templateInView(row, view) && (row.name ?? '').includes(name.trim())),
    [list.items, view, name],
  );
  const paging = useLocalPage(rows, list.loading);
  const orgs = useNames(
    'org',
    paging.shown.map((row) => row.orgId),
  );
  const processName = (id?: string) => (id ? (processes.items?.find((item) => item.id === id)?.name ?? id) : t.noValue);
  const operations = (row: Template) => (
    <RowButtons
      keys={templateActions(row, (action) => permission.can(action, 'detail'))}
      perform={(action) => overlays.perform(row, action)}
    />
  );
  const page = openId ? (
    <TemplateDetailPage
      key={`${openId}/${overlays.version}`}
      id={openId}
      processName={processName}
      orgName={orgs}
      actions={operations}
      onBack={() => open()}
    />
  ) : (
    <ListPage<Template>
      title={t.templates}
      view={{
        value: view,
        options: VIEW_OPTIONS,
        onChange: (value) => {
          setView(value as TemplateView);
          paging.first();
        },
      }}
      data={{ items: paging.shown, total: rows.length, hasDataPermission: list.hasDataPermission }}
      columns={columns(permission.field, orgs, processName, open, operations)}
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
        <HeaderActions create={permission.can('create', 'list') && overlays.create} refresh={overlays.refresh} />
      }
    />
  );
  return (
    <>
      {!openId && <DecisionNote id="idp-templates" />}
      {page}
      {overlays.element}
    </>
  );
}

/** 新增 / 编辑、复制、状态确认与“创建后启用”弹窗；写入后详情按新代次重读，避免继续展示旧 revision。 */
function useTemplateOverlays(reload: () => void, deleted: (id: string) => void) {
  const [editing, setEditing] = useState<{ template?: Template }>();
  const [copying, setCopying] = useState<Template>();
  const [confirming, setConfirming] = useState<{ row: Template; action: Confirmable }>();
  const [enabling, setEnabling] = useState<Template>();
  const [version, setVersion] = useState(0);
  const refresh = () => {
    setVersion((value) => value + 1);
    reload();
  };
  const perform = (row: Template, action: TemplateAction) => {
    if (action === 'update') setEditing({ template: row });
    else if (action === 'copy') setCopying(row);
    else setConfirming({ row, action });
  };
  const element = (
    <>
      {enabling && (
        <EnableAfterCreate key={enabling.id} template={enabling} done={refresh} close={() => setEnabling(undefined)} />
      )}
      {editing && (
        <TemplateForm
          template={editing.template}
          close={() => setEditing(undefined)}
          saved={(created) => {
            if (created) setEnabling(created);
            refresh();
          }}
        />
      )}
      {copying && <CopyDialog source={copying} close={() => setCopying(undefined)} done={refresh} />}
      {confirming && (
        <ConfirmDialog
          key={`${confirming.row.id}/${confirming.action}`}
          {...confirming}
          close={() => setConfirming(undefined)}
          done={(action) => {
            if (action === 'delete') deleted(confirming.row.id);
            refresh();
          }}
        />
      )}
    </>
  );
  return { version, refresh, perform, create: () => setEditing({}), element };
}

function RowButtons({ keys, perform }: { keys: TemplateAction[]; perform(action: TemplateAction): void }) {
  return (
    <Space size={4}>
      {keys.map((key) => (
        <Button key={key} type="link" onClick={() => perform(key)}>
          {key === 'update' ? t.actions.edit : t.actions[key]}
        </Button>
      ))}
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
    // 状态列始终保留：字段被裁剪时显示“无权查看”，不整列消失（原站 B2_09 列表列；DEC-431①）
    {
      key: 'status',
      title: t.fields.templateState,
      width: 90,
      render: (_, row) => statusText(t.templateStatus, row.status),
    },
    field('orgId').visible && { key: 'orgId', title: t.fields.orgId, width: 160, render: (_, row) => orgs(row.orgId) },
    field('publicDown').visible && {
      key: 'publicDown',
      title: t.fields.publicDown,
      width: 90,
      render: (_, row) => yesNo(row.publicDown),
    },
    { key: 'operations', title: t.fields.operations, fixed: 'right', width: 220, render: (_, row) => operations(row) },
  ];
  return all.filter((column) => !!column) as TableColumnsType<Template>;
}

/** 启用 / 停用 / 删除：页面级命令，关闭再打开仍是同一条命令，结果未知时“确定”保持禁用。 */
function ConfirmDialog(props: { row: Template; action: Confirmable; close(): void; done(action: Confirmable): void }) {
  const { row, action, close, done } = props;
  const command = useTemplateCommand(row.id);
  const ok = async () => {
    const path = `${IDP_API}/templates/${row.id}${action === 'delete' ? '' : `/${action}`}`;
    const outcome = await command.run(path, action === 'delete' ? 'DELETE' : 'POST', {}, row.revision!);
    if (!outcome) return;
    command.clear();
    done(action);
    close();
  };
  return (
    <CommandDialog title={t.actions[action]} command={command} ok={() => void ok()} close={close}>
      <p>{CONFIRMS[action]}</p>
    </CommandDialog>
  );
}

/**
 * 复制是新建命令（复制接口按 revision 0 处理）；名称必填 1～100。
 * 命令按源模板存在页面根部：结果未知时关闭再打开仍锁住，不发第二次请求，幂等键不变。
 */
function CopyDialog({ source, close, done }: { source: Template; close(): void; done(): void }) {
  const command = useCommand(`${IDP_API}/templates/${source.id}/copy`);
  const [form] = Form.useForm<{ name: string }>();
  const pending = command.state?.values.name;
  const ok = async () => {
    const values = await form.validateFields();
    const outcome = await command.run(
      `${IDP_API}/templates/${source.id}/copy`,
      'POST',
      { name: values.name.trim() },
      0,
    );
    if (!outcome) return;
    command.clear();
    done();
    close();
  };
  return (
    <CommandDialog title={t.copyTemplate} command={command} ok={() => void ok()} close={close}>
      <Form
        form={form}
        layout="vertical"
        disabled={command.locked}
        initialValues={{ name: typeof pending === 'string' ? pending : `${source.name ?? ''}${t.copySuffix}` }}
      >
        <Form.Item
          name="name"
          label={t.fields.templateName}
          rules={[{ required: true, whitespace: true, max: 100, message: t.required }]}
        >
          <Input maxLength={100} />
        </Form.Item>
      </Form>
    </CommandDialog>
  );
}

/**
 * 新建时选择“开启”：后端没有“创建即启用”的接口，创建成功后接着发起启用命令（后端缺口：非原子）。
 * 启用失败或结果未知时保留提示与命令 ID，模板本身已创建，不回滚、不自动重试。
 */
function EnableAfterCreate({ template, done, close }: { template: Template; done(): void; close(): void }) {
  const command = useTemplateCommand(template.id);
  const started = useRef(false);
  const revision = template.revision;
  useEffect(() => {
    // 创建回执没有 revision 时不补造版本号去启用（同 access.ts 三），提示刷新后再启用
    if (started.current || revision === undefined) return;
    started.current = true;
    void command.run(`${IDP_API}/templates/${template.id}/publish`, 'POST', {}, revision).then((outcome) => {
      if (!outcome) return;
      command.clear();
      done();
      close();
    });
  }, [command, template, revision, done, close]);
  if (revision === undefined)
    return <Alert type="warning" showIcon closable onClose={close} message={t.enableNoRevision} />;
  if (!command.state || command.status === 'submitting' || command.status === 'done') return null;
  return (
    <Alert
      type="error"
      showIcon
      closable
      onClose={close}
      message={t.enableFailed}
      description={<CommandNotice command={command} />}
    />
  );
}

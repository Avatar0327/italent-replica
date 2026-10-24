import { useCallback, useState } from 'react';
import { Alert, Button, Descriptions, Form, Input, Select, Space, Switch, Table, Tag } from 'antd';
import { Link, Route, Routes, useParams } from 'react-router';
import type { ApprovalNode } from '@italent/domain';
import { APPROVAL_TYPES } from '@italent/domain';
import { useApiClient, useSession } from '../../foundation/Session.js';
import { usePermissions } from '../../foundation/Permissions.js';
import { PageState } from '../../foundation/PageState.js';
import { ApiError, rejectionMessage } from '../../foundation/client.js';
import { createFormStore, type Values } from '../../foundation/forms/store.js';
import { FormCommands, useDraftRefill, type CommandForm } from '../../foundation/forms/useCommandForm.js';
import { useConflictCommand } from '../../foundation/forms/ConflictCommands.js';
import { CommandStatus } from '../../foundation/forms/CommandStatus.js';
import { FormLock, LockedField } from '../../foundation/forms/FormLock.js';
import { readProcess, readProcesses, writeProcess } from './api.js';
import {
  attributes,
  base,
  root,
  processObject,
  buildDraft,
  completeDefinition,
  editableValues,
  editAccess,
  nodeField,
  type ProcessView,
  type VersionView,
  type ProcessSummary,
} from './model.js';
import { m } from './messages.js';
import { useRead } from './useRead.js';
import { Conditions, OtherNodeProperties } from './ReadConfiguration.js';
import './designer.css';

// 模块切换不能丢失未知命令；内核按租户 + 身份 + 稳定流程 ID 隔离恢复槽（DEC-464、F-142）。
const commands = createFormStore();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown) => {
  if (value === undefined) return m.unread;
  return value === null || value === '' ? '—' : String(value);
};
const typeName = (code: string) => APPROVAL_TYPES[code as keyof typeof APPROVAL_TYPES]?.name ?? text(code);
const statusName = (status: string | undefined) =>
  ({ draft: m.draft, published: m.published, active: m.active, discarded: m.discarded })[status ?? ''] ?? m.unread;

export function ProcessDesigner() {
  const session = useSession();
  return (
    <FormCommands store={commands}>
      <div className="flow-designer" key={`${session.tenantId}/${session.identityKey}`}>
        <Routes>
          <Route index element={<ProcessList />} />
          <Route path=":id" element={<ProcessDetail />} />
          <Route path="*" element={<PageState kind="not-found" />} />
        </Routes>
      </div>
    </FormCommands>
  );
}
function ReadFailure({ error, retry }: { error: unknown; retry(): void }) {
  let kind: 'forbidden' | 'not-found' | 'error' = 'error';
  if (error instanceof ApiError && error.status === 403) kind = 'forbidden';
  if (error instanceof ApiError && error.status === 404) kind = 'not-found';
  return <PageState kind={kind} error={kind === 'error' ? error : undefined} retry={retry} />;
}
function ProcessList() {
  const api = useApiClient();
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const read = useCallback((signal: AbortSignal) => readProcesses(api, status, page, signal), [api, status, page]);
  const result = useRead(`${status}/${page}`, read);
  return (
    <section>
      <div className="flow-heading">
        <h2>{m.title}</h2>
        <Space>
          <Select
            aria-label={m.status}
            value={status}
            options={[
              { value: 'active', label: m.active },
              { value: 'discarded', label: m.discarded },
            ]}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          />
          <Button onClick={result.refresh}>{m.refresh}</Button>
        </Space>
      </div>
      {result.error ? (
        <ReadFailure error={result.error} retry={result.refresh} />
      ) : (
        <>
          <ProcessTable rows={result.data} />
          <div className="flow-paging">
            <Button disabled={page === 1 || !result.data} onClick={() => setPage(page - 1)}>
              {m.previous}
            </Button>
            <span>{m.page(page)}</span>
            <Button disabled={!result.data || result.data.length < 20} onClick={() => setPage(page + 1)}>
              {m.next}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
function ProcessTable({ rows }: { rows?: ProcessSummary[] }) {
  const permissions = usePermissions(processObject);
  const visible = (field: string, value: unknown) => (permissions.field(field).visible ? value : undefined);
  return (
    <Table<ProcessSummary>
      rowKey="id"
      loading={!rows}
      dataSource={rows}
      pagination={false}
      columns={[
        {
          title: m.name,
          key: 'name',
          render: (_, item) =>
            uuid.test(item.id) ? (
              <Link to={`${root}/${item.id}`}>{text(visible('name', item.latestVersion?.name))}</Link>
            ) : (
              text(visible('name', item.latestVersion?.name))
            ),
        },
        { title: m.code, dataIndex: 'code', render: (value: string) => text(visible('code', value)) },
        {
          title: m.type,
          dataIndex: 'approvalType',
          render: (value: string) => (permissions.field('approvalType').visible ? typeName(value) : m.unread),
        },
        {
          title: m.current,
          key: 'current',
          render: (_, item) => (item.currentVersion === null ? m.none : text(item.currentVersion?.versionNo)),
        },
        {
          title: m.latest,
          key: 'latest',
          render: (_, item) => (
            <Space>
              {text(item.latestVersion?.versionNo)}
              <Tag>{statusName(item.latestVersion?.status)}</Tag>
            </Space>
          ),
        },
      ]}
    />
  );
}
function ProcessDetail() {
  const { id = '' } = useParams();
  return uuid.test(id) ? <DetailLoader id={id.toLowerCase()} /> : <PageState kind="not-found" />;
}
function DetailLoader({ id }: { id: string }) {
  const api = useApiClient();
  const read = useCallback((signal: AbortSignal) => readProcess(api, id, signal), [api, id]);
  const result = useRead(id, read);
  const [notice, setNotice] = useState('');
  return (
    <section>
      <Link to={root}>{m.list}</Link>
      <div className="flow-heading">
        <h2>{m.designer}</h2>
      </div>
      {!!notice && <Alert type="success" showIcon message={notice} closable onClose={() => setNotice('')} />}
      <DetailContent
        id={id}
        data={result.data}
        error={result.error}
        refresh={result.refresh}
        onSaved={(message) => {
          setNotice(message);
          result.refresh();
        }}
      />
    </section>
  );
}
function DetailContent({
  id,
  data,
  error,
  refresh,
  onSaved,
}: {
  id: string;
  data?: ProcessView;
  error?: unknown;
  refresh(): void;
  onSaved(message: string): void;
}) {
  if (error) return <ReadFailure error={error} retry={refresh} />;
  if (!data) return <PageState kind="loading" />;
  return <Definition key={`${id}/${data.revision}`} process={data} onSaved={onSaved} />;
}
function Definition({ process, onSaved }: { process: ProcessView; onSaved(message: string): void }) {
  const [view, setView] = useState<'latest' | 'current'>('latest');
  return (
    <>
      <div className="flow-versions">
        <Space>
          <Button type={view === 'latest' ? 'primary' : 'default'} onClick={() => setView('latest')}>
            {m.latestView}
          </Button>
          {process.currentVersion && (
            <Button type={view === 'current' ? 'primary' : 'default'} onClick={() => setView('current')}>
              {m.currentView}
            </Button>
          )}
        </Space>
        <span>
          {m.current}：{process.currentVersion === null ? m.none : text(process.currentVersion?.versionNo)}
        </span>
      </div>
      {view === 'current' && process.currentVersion ? (
        <ReadOnlyVersion process={process} version={process.currentVersion} />
      ) : (
        <LatestVersion process={process} onSaved={onSaved} />
      )}
    </>
  );
}
function VersionInfo({ process, version }: { process: ProcessView; version: VersionView }) {
  const permissions = usePermissions(processObject);
  const visible = (field: string, value: unknown) => (permissions.field(field).visible ? value : undefined);
  const items: [string, unknown][] = [
    [m.name, visible('name', version.name)],
    [m.code, visible('code', process.code)],
    [m.type, visible('approvalType', typeName(process.approvalType))],
    [m.version, version.versionNo],
    [m.versionStatus, statusName(version.status)],
    [m.status, statusName(process.status)],
    [m.object, process.objectCode],
    [m.group, visible('groupName', version.groupName)],
    [m.priority, visible('priority', version.priority)],
    [m.admin, visible('exceptionAdminUserId', version.exceptionAdminUserId)],
    [m.description, visible('description', version.description)],
  ];
  return (
    <Descriptions
      className="flow-summary"
      size="small"
      column={2}
      items={items.map(([label, value]) => ({
        key: String(label),
        label,
        children: text(value),
      }))}
    />
  );
}
function useProcessCommand(process: ProcessView) {
  const api = useApiClient();
  const permissions = usePermissions(processObject);
  const permission = permissions.snapshot.objects[processObject];
  // enterprise-menus 的既有契约测试证明 matrix.manage 持有者与 process_matrix 能力完全一致；不看角色名或 editable。
  const admin = permissions.menus.some(
    (menu) => menu.key === 'settings' && menu.children?.some((child) => child.key === 'matrix.manage'),
  );
  const action: 'draft' | 'versions' = process.latestVersion.status === 'draft' ? 'draft' : 'versions';
  const snapshotValues = (value: ProcessView) => ({ ...editableValues(value.latestVersion), $process: value });
  const read = async () => {
    const latest = await readProcess(api, process.id);
    if (
      action === 'draft' &&
      (latest.latestVersion.id !== process.latestVersion.id ||
        latest.latestVersion.status !== 'draft' ||
        !completeDefinition(latest.latestVersion) ||
        process.latestVersion.nodes.some(
          (node) => !latest.latestVersion.nodes.some((next) => next.key === node.key && next.kind === node.kind),
        ))
    )
      throw new Error(m.versionChanged);
    return { id: latest.id, revision: latest.revision, values: snapshotValues(latest) };
  };
  const command = useConflictCommand(
    base,
    { id: process.id, revision: process.revision, values: snapshotValues(process) },
    read,
    { action },
  );
  const submission: CommandForm = command.form;
  const full = command.full.$process as ProcessView;
  const version = full.latestVersion;
  const writable =
    !permissions.loading &&
    !permissions.error &&
    full.status === 'active' &&
    editAccess(permission, admin, action === 'draft' ? 'update' : 'newVersion') &&
    completeDefinition(version) &&
    version.status === process.latestVersion.status;
  const nodesVisible = !!permission?.viewableFields.includes('nodes');
  return { api, command, submission, full, version, writable, action, nodesVisible };
}
function LatestVersion({ process, onSaved }: { process: ProcessView; onSaved(message: string): void }) {
  const { api, command, submission, full, version, writable, action, nodesVisible } = useProcessCommand(process);
  const [form] = Form.useForm();
  const [localError, setLocalError] = useState<unknown>();
  const editable = writable && action === 'draft' ? Object.keys(editableValues(version)) : [];
  useDraftRefill(submission, editable, form);
  const labels = Object.fromEntries(
    (nodesVisible ? (version.nodes ?? []) : []).flatMap((node) =>
      attributes.map((field) => [nodeField(node.key, field), `${node.name} · ${m.fields[field]}`]),
    ),
  );
  const submit = async () => {
    if (!writable || submission.locked || submission.blocked) return;
    setLocalError(undefined);
    let values: Values;
    try {
      values = action === 'draft' ? ((await form.validateFields()) as Values) : {};
      // 本地校验在进入内核前完成；send 中的失败只能代表请求结果。
      if (action === 'draft') buildDraft(version, values);
    } catch (error) {
      if (error instanceof Error) setLocalError(error);
      return;
    }
    try {
      await command.run({
        values,
        editableFields: editable,
        send: async ({ edited, command: request }) => {
          await writeProcess(api, process.id, action, {
            ...request,
            body: action === 'draft' ? buildDraft(version, edited) : {},
          });
          return { id: process.id };
        },
      });
      onSaved(action === 'draft' ? m.saved : m.created);
    } catch {
      // 请求状态统一由 CommandStatus 展示，避免确认冲突后又显示旧拒绝信息。
    }
  };
  return (
    <>
      <VersionInfo process={full} version={version} />
      <Conditions version={version} />
      <Alert className="flow-note" type="info" message={action === 'draft' ? m.draftHint : m.publishedHint} />
      {!writable && <p className="flow-muted">{m.restricted}</p>}
      <CommandStatus submission={submission} labels={labels} />
      {submission.state?.readError instanceof Error && submission.state.readError.message === m.versionChanged && (
        <Alert type="warning" message={m.versionChanged} />
      )}
      {!!localError && !submission.state?.error && <Alert type="error" message={rejectionMessage(localError)} />}
      <Form form={form} layout="vertical" initialValues={editableValues(version)}>
        <FormLock locked={!writable || action !== 'draft' || submission.locked || !!submission.blocked}>
          <NodeProperties nodes={nodesVisible ? version.nodes : undefined} />
        </FormLock>
      </Form>
      {writable && (
        <div className="flow-footer">
          <Button
            type="primary"
            aria-label={action === 'draft' ? m.save : m.newVersion}
            loading={submission.busy}
            disabled={submission.locked || submission.blocked}
            onClick={() => void submit()}
          >
            {action === 'draft' ? m.save : m.newVersion}
          </Button>
        </div>
      )}
    </>
  );
}
function ReadOnlyVersion({ process, version }: { process: ProcessView; version: VersionView }) {
  const permission = usePermissions(processObject).snapshot.objects[processObject];
  return (
    <>
      <VersionInfo process={process} version={version} />
      <Conditions version={version} />
      <Tag>{m.readOnly}</Tag>
      <Form layout="vertical" initialValues={editableValues(version)}>
        <FormLock locked>
          <NodeProperties nodes={permission?.viewableFields.includes('nodes') ? version.nodes : undefined} />
        </FormLock>
      </Form>
    </>
  );
}
function NodeProperties({ nodes }: { nodes: readonly ApprovalNode[] | undefined }) {
  const [selected, setSelected] = useState<string>();
  if (!nodes) return <Alert type="info" message={m.missingNodes} />;
  if (!nodes.length) return <Alert type="info" message={m.emptyNodes} />;
  const active = nodes.find((node) => node.key === selected) ?? nodes[0]!;
  const approvers = active.kind === 'countersign' ? active.approvers : [active.approver];
  return (
    <div className="flow-node-layout">
      <nav className="flow-nodes" aria-label={m.nodes}>
        <h3>{m.nodes}</h3>
        {nodes.map((node, index) => (
          <Button
            key={node.key}
            type={active.key === node.key ? 'primary' : 'text'}
            onClick={() => setSelected(node.key)}
          >
            <span className="flow-node-number">{index + 1}</span>
            {text(node.name)}
          </Button>
        ))}
      </nav>
      <div className="flow-properties">
        <h3>{m.properties}</h3>
        <Descriptions
          size="small"
          column={1}
          items={[
            { key: 'key', label: m.nodeKey, children: text(active.key) },
            {
              key: 'kind',
              label: m.nodeKind,
              children:
                ({ countersign: m.countersign, single: m.single } as Record<string, string>)[active.kind ?? ''] ??
                m.unread,
            },
            {
              key: 'approver',
              label: m.approver,
              children: approvers?.map((code) => m.expressions[code] ?? text(code)).join('、') ?? m.unread,
            },
          ]}
        />
        {/* 全部节点字段保持挂载，切换节点不丢未提交输入；只隐藏非当前节点。 */}
        {nodes.map((node) => (
          <div key={node.key} hidden={node.key !== active.key}>
            {attributes.map((field) =>
              editableValues({ nodes: [node] })[nodeField(node.key, field)] === undefined ? (
                <Form.Item key={field} label={m.fields[field]}>
                  {m.unread}
                </Form.Item>
              ) : (
                <Form.Item
                  key={field}
                  name={nodeField(node.key, field)}
                  label={m.fields[field]}
                  valuePropName={field === 'name' ? 'value' : 'checked'}
                  rules={
                    field === 'name' ? [{ required: true, whitespace: true, max: 100, message: m.invalidName }] : []
                  }
                >
                  <LockedField>
                    {field === 'name' ? <Input maxLength={100} aria-label={m.nameLabel} /> : <Switch />}
                  </LockedField>
                </Form.Item>
              ),
            )}
          </div>
        ))}
        <OtherNodeProperties node={active} />
      </div>
    </div>
  );
}

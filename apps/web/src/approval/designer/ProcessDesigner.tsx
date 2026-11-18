import { useCallback, useState } from 'react';
import { Alert, Button, Descriptions, Form, Input, Select, Space, Switch, Table, Tag, type FormInstance } from 'antd';
import { Link, Route, Routes, useParams } from 'react-router';
import type { ApprovalNode, ProcessDefinition } from '@italent/domain';
import { APPROVAL_TYPES } from '@italent/domain';
import { useApiClient, useSession } from '../../foundation/Session.js';
import { usePermissions } from '../../foundation/Permissions.js';
import { PageState } from '../../foundation/PageState.js';
import { ApiError, rejectionMessage } from '../../foundation/client.js';
import { createFormStore, type Latest, type Values } from '../../foundation/forms/store.js';
import { FormCommands, useDraftRefill, type CommandForm } from '../../foundation/forms/useCommandForm.js';
import { useConflictCommand, type Sending } from '../../foundation/forms/ConflictCommands.js';
import { SourceCommandStatus } from './SourceCommandStatus.js';
import { FormLock, LockedField } from '../../foundation/forms/FormLock.js';
import { readProcess, readProcesses } from './api.js';
import {
  attributes,
  base,
  root,
  processObject,
  assertDraftStructure,
  completeDefinition,
  editableValues,
  editAccess,
  buttonAccess,
  draftChanged,
  draftSubmission,
  nodeField,
  type ProcessView,
  type VersionView,
  type ProcessSummary,
} from './model.js';
import { m } from './messages.js';
import { p } from './publish-messages.js';
import { useRead } from './useRead.js';
import { Conditions, OtherNodeProperties } from './ReadConfiguration.js';
import { FallbackHandlers } from './FallbackHandlers.js';
import { ApproverSources } from './ApproverSources.js';
import { sourceFields } from './sources.js';
import { s } from './source-messages.js';
import { locateRejection, localSpot, type Located } from './locate.js';
import { r } from './route-messages.js';
import { routesSummary } from './routes.js';
import { RoutesEditor } from './RoutesEditor.js';
import { useDesignerWrite } from './write.js';
import { PublishButton, PublishStatus, usePublish, type MissingSlot } from './PublishAction.js';
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
  return <Definition key={`${id}/${data.revision}`} process={data} onSaved={onSaved} onRefresh={refresh} />;
}
interface Callbacks {
  onSaved(message: string): void;
  onRefresh(): void;
}
function Definition({ process, onSaved, onRefresh }: { process: ProcessView } & Callbacks) {
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
        <LatestVersion process={process} onSaved={onSaved} onRefresh={onRefresh} />
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
  const snapshotValues = (value: ProcessView) => ({
    ...editableValues(value.latestVersion, value.approvalType),
    $process: value,
  });
  const read = async (): Promise<Latest> => {
    const latest = await readProcess(api, process.id);
    // 冲突重读与未知回查共用；退出重开后仍与原命令基线比较，不能被新详情的结构替换。
    const original = (command.form.state?.baseline.$process as ProcessView | undefined) ?? process;
    if (original.latestVersion.status === 'draft') assertDraftStructure(original.latestVersion, latest.latestVersion);
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
  const usable =
    !permissions.loading &&
    !permissions.error &&
    full.status === 'active' &&
    completeDefinition(version) &&
    version.status === process.latestVersion.status;
  const writable = usable && editAccess(permission, admin, action === 'draft' ? 'update' : 'newVersion');
  const nodesVisible = !!permission?.viewableFields.includes('nodes');
  // F-326 S7b：发布只对草稿开放，按 publish 详情按钮独立授权，不受保存按钮权限连带（catalog 两按钮各自授权）；
  // 发布的是服务端已有草稿、不改节点，不看节点字段权限（P2-4，后端发布入口同样没有节点编辑前置）
  const publishable = usable && action === 'draft' && buttonAccess(permission, admin, 'publish');
  return { api, command, submission, full, version, writable, action, nodesVisible, publishable };
}
function nodeLabels(nodes: readonly ApprovalNode[]) {
  return Object.fromEntries(
    nodes.flatMap((node) => [
      ...attributes.map((field) => [nodeField(node.key, field), `${node.name} · ${m.fields[field]}`]),
      [nodeField(node.key, 'fallbackUserIds'), `${node.name} · ${m.fallback}`],
      [nodeField(node.key, 'routes'), `${node.name} · ${r.title}`],
      ...sourceFields(node).map((field) => [
        nodeField(node.key, field),
        `${node.name} · ${field === 'emptyApproverSources' ? s.empty : s.main}`,
      ]),
    ]),
  );
}
type ProcessCommand = ReturnType<typeof useProcessCommand>;
/** 保存：本地拦截与服务端拒绝都切到出错节点（F-478 S7 设计 §2.2）；409 由内核提示刷新，不自动重提。 */
function useSave(process: ProcessView, context: ProcessCommand, form: FormInstance, onSaved: (text: string) => void) {
  const { api, command, submission, full, version, writable, action } = context;
  const write = useDesignerWrite();
  const [localError, setLocalError] = useState<unknown>();
  const [selected, setSelected] = useState<string>();
  const [located, setLocated] = useState<Located>();
  const point = (spot: Located | undefined) => {
    setLocated(spot);
    if (spot) setSelected(spot.nodeKey);
  };
  const editable = writable && action === 'draft' ? Object.keys(editableValues(version, full.approvalType)) : [];
  const send = async ({ edited, command: request }: Sending) => {
    let draft: ProcessDefinition | undefined;
    try {
      const built = action === 'draft' ? draftSubmission(version, edited, full.approvalType) : undefined;
      draft = built?.draft;
      await write(process.id, action, { ...request, body: built?.body ?? {} });
      return { id: process.id };
    } catch (error) {
      if (action !== 'draft') throw error;
      const result = await locateRejection(error, { draft, approvalType: full.approvalType, api });
      point(result.located);
      throw result.error;
    }
  };
  const submit = async () => {
    if (!writable || submission.locked || submission.blocked) return;
    setLocalError(undefined);
    point(undefined);
    let values: Values;
    try {
      values = action === 'draft' ? ((await form.validateFields()) as Values) : {};
      // 本地校验在进入内核前完成；send 中的失败只能代表请求结果。
      if (action === 'draft') draftSubmission(version, values, full.approvalType);
    } catch (error) {
      point(localSpot(error));
      if (error instanceof Error) setLocalError(error);
      return;
    }
    try {
      await command.run({ values, editableFields: editable, send });
      onSaved(action === 'draft' ? m.saved : m.created);
    } catch {
      // 请求状态统一由 CommandStatus 展示，避免确认冲突后又显示旧拒绝信息。
    }
  };
  return { editable, submit, localError, selected, setSelected, located };
}
function LatestVersion({ process, onSaved, onRefresh }: { process: ProcessView } & Callbacks) {
  const context = useProcessCommand(process);
  const { submission, full, version, writable, action, nodesVisible, publishable } = context;
  const [form] = Form.useForm();
  const save = useSave(process, context, form, onSaved);
  const [missing, setMissing] = useState<MissingSlot[]>([]);
  const publish = usePublish(process, {
    onMissing: (slots) => {
      setMissing(slots);
      if (slots[0]) save.setSelected(slots[0].nodeKey);
    },
    onDone: () => onSaved(p.done),
    onRefresh,
  });
  // 未保存判断与保存同一提交归一化（draftChanged）：改了又改回、只差会被去掉的首尾空格都不算（P2-3）
  const unsaved = () => draftChanged(version, form.getFieldsValue(true) as Values, full.approvalType);
  useDraftRefill(submission, save.editable, form);
  const fields = APPROVAL_TYPES[full.approvalType as keyof typeof APPROVAL_TYPES]?.conditionFields ?? [];
  const format = (field: string, value: unknown) =>
    field.endsWith(':routes') ? routesSummary(value, version.nodes ?? [], fields) : value;
  return (
    <>
      <VersionInfo process={full} version={version} />
      <Conditions version={version} />
      <Alert className="flow-note" type="info" message={action === 'draft' ? m.draftHint : m.publishedHint} />
      {!writable && <p className="flow-muted">{m.restricted}</p>}
      <SourceCommandStatus
        submission={submission}
        labels={nodeLabels(nodesVisible ? (version.nodes ?? []) : [])}
        format={format}
      />
      {submission.state?.readError instanceof Error && submission.state.readError.message === m.versionChanged && (
        <Alert type="warning" message={m.versionChanged} />
      )}
      {/* 未确认的发布命令独立于“现在能否发布”显示：退出重开后最新版本已发布也仍可回查 / 按原单重发（P2-2） */}
      {(publishable || !!publish.form.state) && <PublishStatus publish={publish} />}
      {!!save.localError && !submission.state?.error && (
        <Alert type="error" message={rejectionMessage(save.localError)} />
      )}
      <Form form={form} layout="vertical" initialValues={editableValues(version, process.approvalType)}>
        <FormLock locked={!writable || action !== 'draft' || submission.locked || !!submission.blocked}>
          <NodeProperties
            nodes={nodesVisible ? version.nodes : undefined}
            approvalType={full.approvalType}
            selected={save.selected}
            onSelect={save.setSelected}
            located={save.located}
            missing={missing}
          />
        </FormLock>
      </Form>
      {(writable || publishable) && (
        <div className="flow-footer">
          {writable && (
            <Button
              type="primary"
              aria-label={action === 'draft' ? m.save : m.newVersion}
              loading={submission.busy}
              disabled={submission.locked || submission.blocked}
              onClick={() => void save.submit()}
            >
              {action === 'draft' ? m.save : m.newVersion}
            </Button>
          )}
          {publishable && (
            <PublishButton publish={publish} unsaved={unsaved} disabled={submission.busy || submission.locked} />
          )}
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
      <Form layout="vertical" initialValues={editableValues(version, process.approvalType)}>
        <FormLock locked>
          <NodeProperties
            nodes={permission?.viewableFields.includes('nodes') ? version.nodes : undefined}
            approvalType={process.approvalType}
          />
        </FormLock>
      </Form>
    </>
  );
}
function NodeNav({
  nodes,
  active,
  onSelect,
  missing,
}: {
  nodes: readonly ApprovalNode[];
  active: string;
  onSelect(key: string): void;
  missing?: readonly MissingSlot[];
}) {
  return (
    <nav className="flow-nodes" aria-label={m.nodes}>
      <h3>{m.nodes}</h3>
      {nodes.map((node, index) => (
        <Button
          key={node.key}
          type={active === node.key ? 'primary' : 'text'}
          aria-current={active === node.key ? 'true' : undefined}
          danger={missing?.some((slot) => slot.nodeKey === node.key)}
          data-node-missing={missing?.some((slot) => slot.nodeKey === node.key) ? 'true' : undefined}
          onClick={() => onSelect(node.key)}
        >
          <span className="flow-node-number">{index + 1}</span>
          {text(node.name)}
        </Button>
      ))}
    </nav>
  );
}
const missingText = (missing: readonly MissingSlot[] | undefined, node: ApprovalNode, slot: string) => {
  const hit = missing?.find((item) => item.nodeKey === node.key && item.slot === slot);
  return hit && p.missing(hit.nodeName, hit.slot);
};
function NodeProperties({
  nodes,
  approvalType,
  selected,
  onSelect,
  located,
  missing,
}: {
  nodes: readonly ApprovalNode[] | undefined;
  approvalType: string;
  /** 传入时由保存流程控制当前节点（出错时切到出错节点）；只读版本内部自管。 */
  selected?: string;
  onSelect?(key: string): void;
  located?: Located;
  /** 发布被“指定人员未选择”拒时标出的位置（F-326 S7b）。 */
  missing?: readonly MissingSlot[];
}) {
  const [own, setOwn] = useState<string>();
  if (!nodes) return <Alert type="info" message={m.missingNodes} />;
  if (!nodes.length) return <Alert type="info" message={m.emptyNodes} />;
  const current = onSelect ? selected : own;
  const active = nodes.find((node) => node.key === current) ?? nodes[0]!;
  return (
    <div className="flow-node-layout">
      <NodeNav nodes={nodes} active={active.key} onSelect={onSelect ?? setOwn} missing={missing} />
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
          ]}
        />
        {/* 全部节点字段保持挂载，切换节点不丢未提交输入；只隐藏非当前节点。 */}
        {nodes.map((node) => (
          <div key={node.key} hidden={node.key !== active.key}>
            <ApproverSources node={node} approvalType={approvalType} missing={missingText(missing, node, 'approver')} />
            <ApproverSources
              node={node}
              approvalType={approvalType}
              empty
              missing={missingText(missing, node, 'empty_approver')}
            />
            <FallbackHandlers node={node} approvalType={approvalType} />
            <RoutesEditor node={node} nodes={nodes} approvalType={approvalType} located={located} />
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

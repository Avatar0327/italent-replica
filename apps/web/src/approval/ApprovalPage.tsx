import { normalizeUuid } from '@italent/domain';
import { useEffect, useState } from 'react';
import { SelfServiceShell } from '../self-service/shared/SelfServiceShell.js';
import { ApprovalActions } from './ApprovalActions.js';
import { ApprovalFields } from './ApprovalFields.js';
import { ApprovalHistory, formatApprovalTime, useApprovalHistory, type HistoryState } from './ApprovalHistory.js';
import { PAGE_SIZE, requireUuid, requestMessage } from './api.js';
import { statusLabels, tabLabels, text } from './messages.js';
import { disclosureVersion } from './disclosure.js';
import { readStash, reloadPage } from './pageRecovery.js';
import type { ApprovalDetail, ApprovalListItem, ApprovalTab, FieldDraft } from './types.js';
import { disclosedDraft, useApprovalCommand, type CommandState, type CommandView } from './useApprovalCommand.js';
import { useApprovalInstance } from './useApprovalInstance.js';
import { useApprovalList } from './useApprovalList.js';
import './approval.css';

export function ApprovalPage() {
  const query = new URLSearchParams(window.location.search);
  const initialTenantId = normalizeUuid(query.get('tenantId') ?? '') ?? '';
  const instanceId = normalizeUuid(query.get('instanceId') ?? '');
  const businessId = normalizeUuid(query.get('businessId') ?? '') ?? '';
  const requestedTab = query.get('tab');
  const initialTab = requestedTab === 'processed' || requestedTab === 'initiated' ? requestedTab : 'todos';
  return (
    <SelfServiceShell title={text.title} initialTenantId={initialTenantId}>
      {(tenantId) => (
        <ApprovalWorkspace
          tenantId={tenantId}
          instanceId={instanceId}
          initialTab={initialTab}
          businessId={businessId}
        />
      )}
    </SelfServiceShell>
  );
}
interface WorkspaceProps {
  readonly tenantId: string;
  readonly instanceId?: string | null;
  readonly initialTab?: ApprovalTab;
  readonly businessId?: string;
  /** 服务端判定披露收紧后的整页刷新（DEC-288 止损）；测试注入替身观察调用。 */
  readonly reload?: () => void;
}
/** 租户/深链接变化会销毁所有旧状态，迟到响应无法回填另一租户。 */
export function ApprovalWorkspace(props: WorkspaceProps) {
  return <TenantWorkspace key={`${props.tenantId}:${props.instanceId ?? ''}`} {...props} />;
}
function TenantWorkspace({ tenantId, instanceId, initialTab = 'todos', businessId = '', reload }: WorkspaceProps) {
  const list = useApprovalList(tenantId, initialTab, businessId);
  // 整页刷新后没有实例深链时，按刷新前暂存的命令回到原单，先回查再决定是否重试（DEC-288 止损 ④）。
  const [selectedId, setSelectedId] = useState(() => instanceId ?? readStash(tenantId)?.instanceId ?? null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (list.denied) {
      setSelectedId(null);
      setLocked(false);
    }
  }, [list.denied]);
  function select(item: ApprovalListItem) {
    try {
      setSelectedId(requireUuid(item.instanceId ?? item.id ?? ''));
      setError('');
    } catch (failure) {
      setError(requestMessage(failure));
    }
  }
  return (
    <div className="approval-workspace">
      <ApprovalList list={list} error={error} onSelect={select} locked={locked} />
      {selectedId && !list.denied && (
        <ApprovalDetailPanel
          key={selectedId}
          tenantId={tenantId}
          instanceId={selectedId}
          onClose={() => setSelectedId(null)}
          onDenied={() => {
            setSelectedId(null);
            setLocked(false);
            setError(text.forbidden);
          }}
          onDone={list.refresh}
          onLockChange={setLocked}
          reload={reload ?? reloadPage}
        />
      )}
    </div>
  );
}
function ApprovalList({
  list,
  error,
  onSelect,
  locked,
}: {
  list: ReturnType<typeof useApprovalList>;
  error: string;
  onSelect: (item: ApprovalListItem) => void;
  locked: boolean;
}) {
  return (
    <section className="transfer-content approval-list">
      <nav className="approval-tabs" aria-label={text.title}>
        {(Object.keys(tabLabels) as ApprovalTab[]).map((tab) => (
          <button
            type="button"
            key={tab}
            role="tab"
            aria-selected={list.tab === tab}
            onClick={() => list.selectTab(tab)}
          >
            {tabLabels[tab]}
          </button>
        ))}
      </nav>
      {list.tab !== 'todos' && (
        <form
          className="approval-filter"
          onSubmit={(event) => {
            event.preventDefault();
            list.applyFilter();
          }}
        >
          <label>
            {text.businessId}
            <input
              aria-label={text.businessId}
              value={list.filter}
              onChange={(event) => list.setFilter(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button type="submit">{text.filter}</button>
          <p className="approval-hint">{text.businessHint}</p>
        </form>
      )}
      {list.loading && <p role="status">{text.loading}</p>}
      {(list.error || error) && (
        <p role="alert" className="transfer-error">
          {list.error || error}
        </p>
      )}
      {!list.loading && !list.items.length && <p>{text.empty}</p>}
      <ApprovalRows items={list.items} timezone={list.timezone} onSelect={onSelect} disabled={locked} />
      <div className="approval-button-row">
        <button type="button" disabled={list.loading || list.page === 1} onClick={() => list.setPage(list.page - 1)}>
          {text.previous}
        </button>
        <span>
          {text.page} {list.page} {text.pageUnit}
        </span>
        <button
          type="button"
          disabled={list.loading || list.items.length < PAGE_SIZE}
          onClick={() => list.setPage(list.page + 1)}
        >
          {text.next}
        </button>
        <button type="button" disabled={list.loading || locked} onClick={list.refresh}>
          {text.refresh}
        </button>
      </div>
    </section>
  );
}
function ApprovalRows({
  items,
  timezone,
  onSelect,
  disabled,
}: {
  items: readonly ApprovalListItem[];
  timezone: string;
  onSelect: (item: ApprovalListItem) => void;
  disabled: boolean;
}) {
  return (
    <ul className="approval-list-rows">
      {items.map((item, index) => (
        <li key={item.taskId ?? `${item.id}:${index}`}>
          <button className="approval-row-link" type="button" disabled={disabled} onClick={() => onSelect(item)}>
            {item.title}
            <span>
              {item.nodeName ?? item.currentNodeKey ?? text.none}
              {item.status && ` · ${statusLabels[item.status] ?? item.status}`}
            </span>
            {item.createdAt && <time>{formatApprovalTime(item.createdAt, timezone)}</time>}
          </button>
        </li>
      ))}
    </ul>
  );
}
interface DetailPanelProps {
  readonly tenantId: string;
  readonly instanceId: string;
  readonly onClose: () => void;
  readonly onDenied: () => void;
  readonly onDone: () => void;
  readonly onLockChange: (locked: boolean) => void;
  readonly reload: () => void;
}
function ApprovalDetailPanel(props: DetailPanelProps) {
  const instance = useApprovalInstance(props.tenantId, props.instanceId, props.onDenied, props.reload);
  // DEC-288 ①：命令状态挂在面板层，清空重读与字段集合版本重建都不会销毁它。
  const command = useApprovalCommand({
    tenantId: props.tenantId,
    instanceId: props.instanceId,
    detail: instance.detail,
    requests: instance.requests,
    refresh: instance.refresh,
    onResult: instance.replace,
    onDone: props.onDone,
  });
  const history = useApprovalHistory({
    tenantId: props.tenantId,
    detail: instance.detail,
    requests: instance.requests,
  });
  const locked = command.busy || command.mode === 'unknown';
  useEffect(() => {
    props.onLockChange(locked);
  }, [locked, props.onLockChange]);
  useEffect(() => () => props.onLockChange(false), [props.onLockChange]);
  return (
    <section className="transfer-content approval-detail" aria-label={text.detail}>
      {instance.notice && (
        <p role="status" className="transfer-notice">
          {instance.notice}
        </p>
      )}
      {instance.loading && <p role="status">{text.loading}</p>}
      {instance.error && (
        <p role="alert" className="transfer-error">
          {instance.error}
        </p>
      )}
      {instance.detail ? (
        // 字段集合版本变化或命令确认成功都整体重建展示层：已提交的表单草稿不再带入下一次提交（第 6 轮审查 P2-2）。
        <DetailContents
          key={`${disclosureVersion(instance.detail)}#${command.succeeded}`}
          detail={instance.detail}
          command={command}
          history={history}
          refresh={instance.refresh}
          onClose={props.onClose}
          locked={locked}
        />
      ) : (
        // DEC-288 ③：重读完成前只显示占位，不渲染任何旧字段名或旧值。
        <div className="approval-button-row">
          {command.mode === 'unknown' && command.message && <p role="status">{command.message}</p>}
          {!instance.loading && (
            <button type="button" onClick={() => void instance.refresh().catch(() => undefined)}>
              {text.refreshDetail}
            </button>
          )}
          <button type="button" disabled={locked} onClick={props.onClose}>
            {text.close}
          </button>
        </div>
      )}
    </section>
  );
}
/** 展示层：按字段集合版本（key）整体卸载重建；表单草稿只在这里保存（DEC-288 ④）。 */
function DetailContents(props: {
  detail: ApprovalDetail;
  command: CommandState;
  history: HistoryState;
  refresh: () => Promise<ApprovalDetail | null>;
  onClose: () => void;
  locked: boolean;
}) {
  const [fields, setFields] = useState<FieldDraft>({});
  useEffect(() => setFields((old) => disclosedDraft(props.detail, old)), [props.detail]);
  const actions: CommandView = { ...props.command, submit: () => props.command.submit(fields) };
  const { locked } = props;
  return (
    <>
      <div className="approval-detail-heading">
        <h2>{props.detail.title}</h2>
        <button type="button" disabled={locked} onClick={() => void props.refresh().catch(() => undefined)}>
          {text.refreshDetail}
        </button>
        <button type="button" disabled={locked} onClick={props.onClose}>
          {text.close}
        </button>
      </div>
      <dl className="approval-summary">
        <div>
          <dt>{text.status}</dt>
          <dd>{statusLabels[props.detail.status] ?? props.detail.status}</dd>
        </div>
        <div>
          <dt>{text.node}</dt>
          <dd>{props.detail.currentNodeKey ?? text.none}</dd>
        </div>
        <div>
          <dt>{text.createdAt}</dt>
          <dd>{formatApprovalTime(props.detail.createdAt, props.detail.timezone)}</dd>
        </div>
        {props.detail.completedAt && (
          <div>
            <dt>{text.completedAt}</dt>
            <dd>{formatApprovalTime(props.detail.completedAt, props.detail.timezone)}</dd>
          </div>
        )}
      </dl>
      {props.detail.status === 'approved' && <p className="approval-hint">{text.approvedHint}</p>}
      {props.detail.form.editMode !== 'none' && (
        <p className="approval-hint">{props.detail.form.editMode === 'separate' ? text.separate : text.withApprove}</p>
      )}
      <ApprovalFields form={props.detail.form} draft={fields} onDraft={setFields} disabled={locked} />
      <ApprovalActions detail={props.detail} command={actions} />
      <ApprovalHistory detail={props.detail} history={props.history} />
    </>
  );
}

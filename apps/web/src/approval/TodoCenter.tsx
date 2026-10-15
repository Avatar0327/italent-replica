import { Alert, Button, Checkbox, Empty, Input, Space, Spin, Tag, Tooltip } from 'antd';
import { useNavigate, useSearchParams } from 'react-router';
import { DecisionNote, PageState } from '../foundation/index.js';
import { ApprovalDetail, formatInstant } from './ApprovalDetail.js';
import { centerText as c, instanceStatus, messages as m, typeLabels } from './messages.js';
import {
  approvalSections,
  todoSort,
  todoToolTargets,
  todoTools,
  type ApprovalSection,
  type TodoTool,
} from './page-model.js';
import type { ApprovalRow, ApprovalView } from './types.js';
import { useApprovalList, type ApprovalListState } from './useApprovalList.js';

const views: readonly ApprovalView[] = ['pending', 'completed', 'initiated'];
const isView = (value: string | null): value is ApprovalView => views.some((view) => view === value);

/**
 * 我的待办按原站：左侧分类栏（搜索 + 待处理 / 已处理 / 已申请），右侧卡片列表。
 * 原站卡片在新标签打开详情；这里在当前页打开并带返回（偏离见 PR）。
 */
export function TodoCenter({ visible }: { visible: readonly ApprovalSection[] }) {
  const [params, setParams] = useSearchParams();
  const value = params.get('view');
  const view: ApprovalView = isView(value) ? value : 'pending';
  const state = useApprovalList(view);
  if (state.selected)
    return (
      <ApprovalDetail
        key={state.selected.id}
        layout="page"
        row={state.selected}
        demo={state.data.demo}
        onClose={() => state.setSelected(undefined)}
        onChanged={state.refresh}
      />
    );
  return (
    <div className="approval-todo">
      <TodoCategories view={view} onChange={(next) => setParams({ view: next })} />
      <div className="approval-todo-main">
        <TodoToolbar view={view} visible={visible} state={state} />
        <DecisionNote id="approval" />
        {state.data.demo && <Alert showIcon type="info" message={m.demo} description={m.completedGap} />}
        <TodoCards view={view} state={state} />
        <TodoPager state={state} />
      </div>
    </div>
  );
}
function TodoCategories({ view, onChange }: { view: ApprovalView; onChange(view: ApprovalView): void }) {
  return (
    <nav className="approval-categories" aria-label={c.categories}>
      <Tooltip title={c.searchPending}>
        <Input disabled aria-label={c.searchContent} placeholder={c.searchContent} />
      </Tooltip>
      {views.map((key) => (
        <Button
          key={key}
          type="text"
          aria-pressed={key === view}
          className={key === view ? 'approval-category approval-category-active' : 'approval-category'}
          onClick={() => onChange(key)}
        >
          {m[key]}
        </Button>
      ))}
    </nav>
  );
}
const toolLabels: Record<TodoTool, string> = {
  batchApprove: c.batchApprove,
  batchDisagree: c.batchDisagree,
  delegate: c.delegate,
  manage: c.manage,
};
/** 批量审批没有接口，禁用；流程委托 / 流程管理跳到对应子页，无权限的子页不显示入口。 */
function TodoToolbar(props: { view: ApprovalView; visible: readonly ApprovalSection[]; state: ApprovalListState }) {
  const navigate = useNavigate();
  const { view, visible, state } = props;
  const pathOf = (target?: ApprovalSection) => approvalSections.find((section) => section.key === target)?.path;
  return (
    <header className="approval-todo-head">
      <h2>{m[view]}</h2>
      <Space wrap>
        {todoTools[view].map((tool) => {
          const target = todoToolTargets[tool];
          const path = target && visible.includes(target) ? pathOf(target) : undefined;
          if (target && !path) return null;
          return path ? (
            <Button key={tool} onClick={() => navigate(path)}>
              {toolLabels[tool]}
            </Button>
          ) : (
            <Tooltip key={tool} title={c.pendingTool}>
              <Button disabled>{toolLabels[tool]}</Button>
            </Tooltip>
          );
        })}
        <span className="approval-sort">{todoSort[view]}</span>
        <Button onClick={state.refresh} loading={state.loading}>
          {m.refresh}
        </Button>
      </Space>
    </header>
  );
}
function TodoCards({ view, state }: { view: ApprovalView; state: ApprovalListState }) {
  if (state.error) return <PageState kind="error" error={state.error} retry={state.refresh} />;
  if (state.loading) return <Spin className="approval-cards-loading" />;
  if (!state.data.items.length) return <Empty description={c.empty} />;
  return (
    <ul className="approval-cards">
      {state.data.items.map((row) => (
        <TodoCard
          key={row.taskId ?? row.id}
          row={row}
          view={view}
          timezone={state.timezone}
          onOpen={() => state.setSelected(row)}
        />
      ))}
    </ul>
  );
}
/** 卡片：复选（仅待处理，批量接口待补齐故禁用）、头像位、标题、摘要、时间、右侧按钮；已申请卡片标题旁有状态标签。 */
function TodoCard(props: { row: ApprovalRow; view: ApprovalView; timezone: string; onOpen(): void }) {
  const { row, view } = props;
  const status = view === 'initiated' ? instanceStatus[row.status ?? ''] : undefined;
  return (
    <li className="approval-card">
      {view === 'pending' && <Checkbox disabled aria-label={row.title} />}
      <span className="approval-record-mark" aria-hidden>
        {m.mark}
      </span>
      <div className="approval-card-body">
        <div className="approval-card-title">
          <Button type="link" className="approval-title-link" onClick={props.onOpen}>
            {row.title}
          </Button>
          {status && <Tag className={`approval-tone approval-tone-${status.tone}`}>{status.label}</Tag>}
        </div>
        <div className="approval-record-meta">
          {c.summary(typeLabels[row.approvalType] ?? row.approvalType, row.nodeName)}
        </div>
        <small className="approval-muted">{formatInstant(row.createdAt, props.timezone)}</small>
      </div>
      <Button className="approval-card-action" onClick={props.onOpen}>
        {view === 'pending' ? m.handle : m.view}
      </Button>
    </li>
  );
}
/** 原站卡片页无页码、纵向滚动；接口按页返回，这里保留上一页 / 下一页，不伪造总数。 */
function TodoPager({ state }: { state: ApprovalListState }) {
  const { page, data } = state;
  const more = data.hasMore ?? (data.total ?? 0) > page.page * page.pageSize;
  if (page.page === 1 && !more) return null;
  return (
    <Space className="approval-pager">
      <Button disabled={page.page === 1} onClick={() => state.setPage({ ...page, page: page.page - 1 })}>
        {c.previous}
      </Button>
      <span>{c.pageNo(page.page)}</span>
      <Button disabled={!more} onClick={() => state.setPage({ ...page, page: page.page + 1 })}>
        {c.next}
      </Button>
    </Space>
  );
}

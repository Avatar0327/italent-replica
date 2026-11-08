import { Alert, Button, Popconfirm, Space, Tabs } from 'antd';
import { useState } from 'react';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { PageState } from '../foundation/PageState.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { ApiError } from '../foundation/client.js';
import { tr } from './messages.js';
import { objects, type ReviewRecord } from './types.js';
import { useReviewController } from './useReviewController.js';
import { ReviewList } from './ReviewList.js';
import { ProjectDetail } from './ProjectDetail.js';
import { RecordForm } from './RecordForm.js';
import { Meetings } from './Meetings.js';
import { MatrixSettings } from './MatrixSettings.js';
import { Templates } from './Templates.js';
import { CalcRules } from './CalcRules.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import './review.css';

export function TalentReviewPage() {
  const session = useSession();
  const project = usePermissions(objects.projects);
  const template = usePermissions(objects.templates);
  const calcRule = usePermissions(objects['calc-rules']);
  const matrix = usePermissions(objects.matrices);
  const [selected, setSelected] = useState('projects');
  const permissions = { projects: project, templates: template, 'calc-rules': calcRule, matrices: matrix };
  const items = (['projects', 'templates', 'calc-rules', 'matrices'] as const)
    .filter((key) => !!permissions[key].snapshot.objects[objects[key]])
    .map((key) => ({ key: key as string, label: tr[key] }));
  if (project.snapshot.objects[objects.projects])
    items.push({ key: 'meetings', label: tr.meetings }, { key: 'pools', label: tr.pools });
  const active = items.some((item) => item.key === selected) ? selected : items[0]?.key;
  // 表单命令存储放在页面根部：切页签、整页返回列表后，结果未知的命令仍锁定（DEC-502① e、g）。
  return (
    <FormCommands>
      <div className="talent-review-page">
        <Tabs activeKey={active} onChange={setSelected} items={items} />
        {active ? (
          renderTab(active, `${session.tenantId}/${session.identityKey}/${active}`)
        ) : (
          <PageState kind={project.loading ? 'loading' : 'forbidden'} />
        )}
      </div>
    </FormCommands>
  );
}
/** 页签内容：key 带租户 / 身份，切换身份即重挂载，不沿用上一身份的列表状态。 */
function renderTab(active: string, key: string) {
  if (active === 'meetings' || active === 'pools') return <Meetings pool={active === 'pools'} />;
  if (active === 'matrices') return <MatrixSettings key={key} />;
  if (active === 'calc-rules') return <CalcRules key={key} />;
  if (active === 'templates') return <Templates key={key} />;
  return <ProjectsPage key={key} />;
}
/** 盘点项目（F-475 盘点 A 已对齐）：列表、详情整页与编辑弹窗；模板、九宫格各有自己的整页。 */
function ProjectsPage() {
  const state = useReviewController('projects');
  const { permission, result, selected, select, detail, error, editing, setEditing, refresh } = state;
  const actions = (row: ReviewRecord, inDetail = false) => <RowActions row={row} inDetail={inDetail} state={state} />;
  return (
    <>
      <DecisionNote id="talent-review-projects" />
      {!!error && (
        <Alert
          type="error"
          showIcon
          message={error instanceof Error ? error.message : tr.unknown}
          action={<Button onClick={refresh}>{tr.refresh}</Button>}
        />
      )}
      <div hidden={!!selected}>
        <ReviewList
          {...result}
          retry={refresh}
          open={(row) => select({ id: row.id })}
          rowActions={(row) => actions(row)}
          actions={
            permission.can('create', 'list') ? (
              <Button type="primary" onClick={() => setEditing('new')}>
                {tr.create}
              </Button>
            ) : null
          }
        />
      </div>
      {selected && selected.id !== detail?.id && <Button onClick={() => select(undefined)}>{tr.back}</Button>}
      {selected && !detail && !error && <PageState kind="loading" />}
      {detail && selected?.id === detail.id && (
        <ProjectDetail record={detail} actions={actions(detail, true)} onClose={() => select(undefined)} />
      )}
      {editing && (
        <RecordForm
          record={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
          saved={refresh}
          refresh={refresh}
        />
      )}
      {error instanceof ApiError && error.kind === 'unknown' && <p role="alert">{tr.unknown}</p>}
    </>
  );
}

function RowActions({
  row,
  inDetail,
  state,
}: {
  row: ReviewRecord;
  inDetail: boolean;
  state: ReturnType<typeof useReviewController>;
}) {
  const buttonType = inDetail ? 'primary' : 'link';
  const order = inDetail ? ['start', 'end', 'restart', 'update'] : ['update', 'end', 'start', 'restart'];
  return (
    <Space size={8}>
      {state
        .actionsFor(row)
        .sort((a, b) => order.indexOf(a) - order.indexOf(b))
        .map((action) =>
          action === 'update' ? (
            <Button
              key={action}
              type={buttonType}
              disabled={state.busy}
              onClick={() => state.select({ id: row.id, editing: true })}
            >
              {inDetail ? tr.editProject : tr.update}
            </Button>
          ) : (
            <Popconfirm
              key={action}
              title={action === 'end' ? tr.confirmEnd : tr.confirmAction}
              onConfirm={() => state.transition(row, action)}
            >
              <Button type={buttonType} disabled={state.busy}>
                {tr[action]}
              </Button>
            </Popconfirm>
          ),
        )}
    </Space>
  );
}

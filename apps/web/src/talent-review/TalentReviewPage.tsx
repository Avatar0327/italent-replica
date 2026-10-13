import { Alert, Button, Popconfirm, Space, Tabs } from 'antd';
import { useState } from 'react';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { PageState } from '../foundation/PageState.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { ApiError } from '../foundation/client.js';
import { tr } from './messages.js';
import { objects, type Collection, type ReviewRecord } from './types.js';
import { useReviewController } from './useReviewController.js';
import { ReviewList } from './ReviewList.js';
import { RecordDetail } from './RecordDetail.js';
import { RecordForm } from './RecordForm.js';
import { Meetings } from './Meetings.js';
import './review.css';

export function TalentReviewPage() {
  const session = useSession();
  const project = usePermissions(objects.projects);
  const template = usePermissions(objects.templates);
  const matrix = usePermissions(objects.matrices);
  const [selected, setSelected] = useState('projects');
  const items = (['projects', 'templates', 'matrices'] as const)
    .filter((key) => !!{ projects: project, templates: template, matrices: matrix }[key].snapshot.objects[objects[key]])
    .map((key) => ({ key: key as string, label: tr[key] }));
  if (project.snapshot.objects[objects.projects]) items.push({ key: 'meetings', label: tr.meetings });
  const active = items.some((item) => item.key === selected) ? selected : items[0]?.key;
  return (
    <div className="talent-review-page">
      <Tabs activeKey={active} onChange={setSelected} items={items} />
      {!active ? (
        <PageState kind={project.loading ? 'loading' : 'forbidden'} />
      ) : active === 'meetings' ? (
        <Meetings />
      ) : (
        <CollectionPage
          key={`${session.tenantId}/${session.identityKey}/${active}`}
          collection={active as Collection}
        />
      )}
    </div>
  );
}
function CollectionPage({ collection }: { collection: Collection }) {
  const state = useReviewController(collection);
  const { permission, result, selected, select, detail, error, editing, setEditing, refresh } = state;
  const actions = (row: ReviewRecord, inDetail = false) => (
    <RowActions row={row} inDetail={inDetail} collection={collection} state={state} />
  );
  return (
    <>
      <DecisionNote id={`talent-review-${collection}`} />
      {!!error && (
        <Alert
          type="error"
          showIcon
          message={error instanceof Error ? error.message : tr.unknown}
          action={<Button onClick={refresh}>{tr.refresh}</Button>}
        />
      )}
      <ReviewList
        collection={collection}
        {...result}
        retry={refresh}
        open={(row) => select({ id: row.id })}
        rowActions={(row) => actions(row)}
        actions={
          collection !== 'matrices' && permission.can('create', 'list') ? (
            <Button type="primary" onClick={() => setEditing('new')}>
              {tr.create}
            </Button>
          ) : null
        }
      />
      {selected && !detail && !error && <PageState kind="loading" />}
      {detail && (
        <RecordDetail
          collection={collection}
          record={detail}
          actions={actions(detail, true)}
          onClose={() => select(undefined)}
        />
      )}
      {editing && (
        <RecordForm
          collection={collection}
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
  collection,
  state,
}: {
  row: ReviewRecord;
  inDetail: boolean;
  collection: Collection;
  state: ReturnType<typeof useReviewController>;
}) {
  const editLabel = collection === 'projects' ? tr.editProject : tr.editTemplate;
  return (
    <Space size={8}>
      {state.actionsFor(row).map((action) =>
        action === 'update' ? (
          <Button
            key={action}
            type="link"
            disabled={state.busy}
            onClick={() => state.select({ id: row.id, editing: true })}
          >
            {inDetail ? editLabel : tr.update}
          </Button>
        ) : (
          <Popconfirm
            key={action}
            title={action === 'end' ? tr.confirmEnd : tr.confirmAction}
            onConfirm={() => state.transition(row, action)}
          >
            <Button type="link" disabled={state.busy}>
              {tr[action]}
            </Button>
          </Popconfirm>
        ),
      )}
    </Space>
  );
}

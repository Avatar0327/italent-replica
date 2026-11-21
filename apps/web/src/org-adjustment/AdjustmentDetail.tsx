import { Button, Descriptions, Modal, Space } from 'antd';
import { labels, text } from './messages.js';
import { useState } from 'react';
import { ApiError } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { PageState } from '../foundation/PageState.js';
import { useSession } from '../foundation/Session.js';
import { DetailPage } from '../foundation/templates.js';
import { useRemote } from '../org/page-support.js';
import { ApplicationForm, EditorPlaceholder } from './ApplicationForm.js';
import { useAdjustmentAccess, useAdjustmentCommand } from './commands.js';
import { ApprovalHistory, OrgSections } from './DetailSections.js';
import { detailPath, display, editableOrder, rangeLabel, type Detail } from './model.js';
import { Preview } from './Preview.js';

interface Props {
  id: string;
  voiding?: boolean;
  close(): void;
  refreshList?(): void;
}
export function AdjustmentDetail(props: Props) {
  const remote = useRemote<Detail>(detailPath(props.id));
  const row = remote.data;
  return (
    <DetailPage
      open
      title={row ? display(row.subject) : text.application}
      onClose={props.close}
      summary={
        row ? (
          <DetailBody
            {...props}
            row={row}
            refresh={() => {
              props.refreshList?.();
              remote.refresh();
            }}
          />
        ) : (
          <PageState
            kind={
              remote.loading
                ? 'loading'
                : remote.error instanceof ApiError && remote.error.status === 404
                  ? 'not-found'
                  : 'error'
            }
            error={remote.error}
            retry={remote.refresh}
          />
        )
      }
    />
  );
}

function DetailBody({ row, voiding, refresh }: Props & { row: Detail; refresh(): void }) {
  const { userId } = useSession();
  const access = useAdjustmentAccess();
  const command = useAdjustmentCommand(row, refresh, access);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(!!voiding);
  const mayEdit = row.contentView.mode === 'live' && editableOrder(row, userId);
  const edit = mayEdit && access.edit;
  const allowVoid = mayEdit && access.void;
  const act = (action: 'submit' | 'void') => {
    void command.send(action).catch(() => {
      // 已由内核保存失败或未知状态，留在详情供用户查看及恢复。
    });
  };
  return (
    <div className="oa-detail">
      {!editing && (
        <CommandStatus
          submission={command.form}
          labels={Object.fromEntries(Object.entries(labels).filter(([name]) => command.access.field(name).visible))}
        />
      )}
      <section aria-label={text.application}>
        <div className="oa-section-heading">
          <h2>{text.application}</h2>
          <Space wrap>
            {edit && (
              <>
                <Button disabled={command.form.locked} onClick={() => setEditing(true)}>
                  {text.edit}
                </Button>
                <EditorPlaceholder disabled={command.form.locked} />
                <Button
                  type="primary"
                  disabled={command.form.locked}
                  loading={command.form.busy}
                  onClick={() => act('submit')}
                >
                  {text.submit}
                </Button>
              </>
            )}
            {allowVoid && (
              <Button danger disabled={command.form.locked} onClick={() => setConfirming(true)}>
                {text.void}
              </Button>
            )}
          </Space>
        </div>
        <HeadSummary row={row} />
      </section>
      <section aria-label={text.preview}>
        <h2>{text.preview}</h2>
        <Preview id={row.id} />
      </section>
      {!!row.sections.org?.count && (
        <section aria-label={text.items}>
          <h2>{text.items}</h2>
          <OrgSections id={row.id} />
        </section>
      )}
      <section aria-label={text.history}>
        <h2>{text.history}</h2>
        <ApprovalHistory key={row.approvalInstanceId ?? 'empty'} id={row.approvalInstanceId} />
      </section>
      <Modal
        open={allowVoid && confirming}
        title={text.voidConfirm}
        okText={text.void}
        onCancel={() => setConfirming(false)}
        onOk={() => {
          setConfirming(false);
          act('void');
        }}
      />
      {editing && <ApplicationForm row={row} command={command} onClose={() => setEditing(false)} />}
    </div>
  );
}

function HeadSummary({ row }: { row: Detail }) {
  return (
    <Descriptions
      size="small"
      column={2}
      items={[
        { key: 'effectiveDate', label: labels.effectiveDate, children: display(row.effectiveDate) },
        { key: 'subjectOrg', label: labels.approvalSubjectOrgId, children: display(row.approvalSubjectOrgName) },
        { key: 'range', label: labels.adjustmentRange, children: rangeLabel(row.adjustmentRange) },
        { key: 'status', label: labels.approvalStatus, children: display(row.approvalStatusLabel) },
        { key: 'execution', label: labels.executionStatus, children: display(row.executionStatusLabel) },
        { key: 'note', label: labels.executionNote, children: display(row.executionNote) },
        { key: 'content', label: labels.content, children: display(row.content), span: 2 },
      ]}
    />
  );
}

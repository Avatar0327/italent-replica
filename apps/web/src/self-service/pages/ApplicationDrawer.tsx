import { Alert, Button, Descriptions } from 'antd';
import { useEffect, useState } from 'react';
import { messages as kernel } from '../../foundation/forms/messages.js';
import { EmployeeTransfer } from '../../employee-self-service/EmployeeTransfer.js';
import type { Profile } from '../../employee-self-service/types.js';
import { TransferApplication } from '../shared/TransferApplication.js';
import { text as t } from '../../transfer/messages.js';
import type { TransferFormModel } from '../../transfer/types.js';
import { useSession } from '../../foundation/Session.js';
import { FormDrawer } from './parts.js';
import { messages as m } from './messages.js';
import { useApplicationCommand, type ApplicationState } from './useApplicationCommand.js';
import { SavedApplication } from './SavedApplication.js';
import { keptForm } from '../shared/useTransferForm.js';

interface ApplicationDrawerProps {
  open: boolean;
  onClose(): void;
  tenantId: string;
  profile?: Profile;
  onSaved?(): void;
}

/** F-537：本页草稿随租户、身份、入口和本人绑定隔离，生命周期高于抽屉。 */
export function ApplicationDrawer(props: ApplicationDrawerProps) {
  const { profile, tenantId } = props;
  const { identityKey } = useSession();
  const scope = JSON.stringify([tenantId, identityKey, profile ? 'employee' : 'manager']);
  return <ApplicationDraftDrawer key={JSON.stringify([scope, profile?.employee.id])} scope={scope} {...props} />;
}

function ApplicationDraftDrawer({ scope, ...props }: ApplicationDrawerProps & { scope: string }) {
  const { profile, tenantId } = props;
  const state = useApplicationCommand(scope, profile ? props.onSaved : undefined);
  const pageDraft = useState<TransferFormModel>();
  const [, setDraft] = pageDraft;
  useEffect(() => {
    if (state.saved) setDraft(undefined);
  }, [state.saved, setDraft]);
  const close = () => {
    // 关闭期间可以落定。保留用户输入，重开后按重新读到的预览和当前权限回填。
    if (state.pending || state.error) setDraft((current) => current && keptForm(current));
    else setDraft(undefined);
    props.onClose();
  };
  const title = profile ? m.transfer : m.manager.apply;
  let content;
  if (state.saved && !profile) content = <SavedApplication id={state.saved.id} tenantId={tenantId} run={state.run} />;
  else if (state.saved) content = <p role="status">{m.submitted}</p>;
  else if (profile)
    content = (
      <EmployeeTransfer
        tenantId={tenantId}
        profile={profile}
        onSaved={() => {}}
        runCommand={state.run}
        pageDraft={pageDraft}
      />
    );
  else
    content = (
      <TransferApplication tenantId={tenantId} initiator="manager" runCommand={state.run} pageDraft={pageDraft} />
    );
  return (
    <FormDrawer open={props.open} onClose={close} title={title}>
      {state.error && <Alert type="error" message={state.error} />}
      {/* DEC-473：待确认时保持只读，结果确定失败或未执行后恢复编辑。 */}
      <div hidden={!!state.pending} inert={!!state.pending}>
        {content}
      </div>
      {state.pending && <PendingApplication state={state} tenantId={tenantId} />}
      {!state.pending && state.saved && state.saved.status !== 'draft' && (
        <Button onClick={state.clearConfirmed}>{t.newApplication}</Button>
      )}
      {state.pending?.businessId && <SavedApplication id={state.pending.businessId} tenantId={tenantId} locked />}
    </FormDrawer>
  );
}
function PendingApplication({ state, tenantId }: { state: ApplicationState; tenantId: string }) {
  const command = state.pending!;
  return (
    <section>
      <p role="status">{m.processing}</p>
      {state.race && <Alert type="warning" showIcon message={state.race} />}
      {state.resultPending && <Alert type="info" showIcon message={kernel.resultPending} />}
      {state.queryFailed && <Alert type="error" showIcon message={m.queryFailed} />}
      <Descriptions
        column={1}
        items={[
          { key: 'command', label: t.requestReference, children: command.commandId },
          { key: 'employee', label: t.employee, children: command.employeeId },
          { key: 'business', label: m.businessId, children: command.businessId ?? m.unread },
          { key: 'date', label: t.date, children: command.effectiveDate ?? m.unread },
          {
            key: 'summary',
            label: m.submissionSummary,
            children: state.restored ? m.restoredSummary : JSON.stringify(command.summary),
          },
        ]}
      />
      <p>{m.unknownHint}</p>
      <p>{m.refreshAfterConfirm}</p>
      <Button type="primary" loading={state.reading} onClick={() => void state.query(tenantId)}>
        {kernel.query}
      </Button>
    </section>
  );
}

import { Alert, Descriptions } from 'antd';
import { EmployeeTransfer } from '../../employee-self-service/EmployeeTransfer.js';
import type { Profile } from '../../employee-self-service/types.js';
import { TransferApplication } from '../shared/TransferApplication.js';
import type { ApplicationCommand } from '../shared/application-command.js';
import { text as t } from '../../transfer/messages.js';
import { FormDrawer } from './parts.js';
import { messages as m } from './messages.js';
import { useApplicationCommand } from './useApplicationCommand.js';
import { SavedApplication } from './SavedApplication.js';

/** 必须在页面内常驻，不能放入随关闭卸载的 FormDrawer children。 */
export function ApplicationDrawer(props: {
  open: boolean;
  onClose(): void;
  tenantId: string;
  profile?: Profile;
  onSaved?(): void;
}) {
  const { profile, tenantId } = props;
  const state = useApplicationCommand(profile ? props.onSaved : undefined);
  const title = profile ? m.transfer : m.manager.apply;
  let content;
  if (state.pending) content = <PendingApplication command={state.pending} />;
  else if (state.saved && !profile)
    content = <SavedApplication id={state.saved.id} tenantId={tenantId} run={state.run} />;
  else if (state.saved) content = <p role="status">{m.submitted}</p>;
  else if (profile)
    content = <EmployeeTransfer tenantId={tenantId} profile={profile} onSaved={() => {}} runCommand={state.run} />;
  else content = <TransferApplication tenantId={tenantId} initiator="manager" runCommand={state.run} />;
  return (
    <FormDrawer open={props.open} onClose={props.onClose} title={title}>
      {state.error && <Alert type="error" message={state.error} />}
      {content}
      {state.pending?.businessId && <SavedApplication id={state.pending.businessId} tenantId={tenantId} locked />}
    </FormDrawer>
  );
}
function PendingApplication({ command }: { command: ApplicationCommand }) {
  return (
    <section>
      <p role="status">{m.processing}</p>
      <Descriptions
        column={1}
        items={[
          { key: 'command', label: t.requestReference, children: command.commandId },
          { key: 'employee', label: t.employee, children: command.employeeId },
          { key: 'business', label: m.businessId, children: command.businessId ?? m.unread },
          { key: 'date', label: t.date, children: command.effectiveDate ?? m.unread },
          { key: 'summary', label: m.submissionSummary, children: JSON.stringify(command.summary) },
        ]}
      />
      <p>{m.unknownHint}</p>
      <p>{m.refreshAfterConfirm}</p>
    </section>
  );
}

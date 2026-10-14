import { Alert, Button, Descriptions } from 'antd';
import { EmployeeTransfer } from '../../employee-self-service/EmployeeTransfer.js';
import type { Profile } from '../../employee-self-service/types.js';
import { TransferApplication } from '../shared/TransferApplication.js';
import type { ApplicationCommand } from '../shared/application-command.js';
import { text as t } from '../../transfer/messages.js';
import { useSession } from '../../foundation/Session.js';
import { FormDrawer } from './parts.js';
import { messages as m } from './messages.js';
import { useApplicationCommand } from './useApplicationCommand.js';
import { SavedApplication } from './SavedApplication.js';

/** 抽屉只展示页面会话状态；关闭或切换路由都不能解锁未确认命令。 */
export function ApplicationDrawer(props: {
  open: boolean;
  onClose(): void;
  tenantId: string;
  profile?: Profile;
  onSaved?(): void;
}) {
  const { profile, tenantId } = props;
  const { identityKey } = useSession();
  const scope = JSON.stringify([tenantId, identityKey, profile ? 'employee' : 'manager']);
  const state = useApplicationCommand(scope, profile ? props.onSaved : undefined);
  const title = profile ? m.transfer : m.manager.apply;
  let content;
  if (state.saved && !profile) content = <SavedApplication id={state.saved.id} tenantId={tenantId} run={state.run} />;
  else if (state.saved) content = <p role="status">{m.submitted}</p>;
  else if (profile)
    content = <EmployeeTransfer tenantId={tenantId} profile={profile} onSaved={() => {}} runCommand={state.run} />;
  else content = <TransferApplication tenantId={tenantId} initiator="manager" runCommand={state.run} />;
  return (
    <FormDrawer open={props.open} onClose={props.onClose} title={title}>
      {state.error && <Alert type="error" message={state.error} />}
      {/* DEC-473：提交期间保留原表单实例，明确拒绝后恢复输入；未知结果仍不可操作。 */}
      <div hidden={!!state.pending} inert={!!state.pending}>
        {content}
      </div>
      {state.pending && <PendingApplication command={state.pending} />}
      {!state.pending && state.saved && state.saved.status !== 'draft' && (
        <Button onClick={state.clearConfirmed}>{t.newApplication}</Button>
      )}
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

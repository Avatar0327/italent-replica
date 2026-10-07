import { allowedAddSignTypes } from './commands.js';
import { actionLabels, text } from './messages.js';
import { editableLeaf, editableValue, fieldLeaves } from './fields.js';
import type { ActionDraft, ApprovalAction, ApprovalDetail } from './types.js';
import type { useApprovalCommand } from './useApprovalCommand.js';

type Actions = ReturnType<typeof useApprovalCommand>;
export function ApprovalActions({ detail, command }: { detail: ApprovalDetail; command: Actions }) {
  const canEdit =
    detail.form.editMode === 'separate' &&
    fieldLeaves(detail.form.values).some(
      (leaf) => editableLeaf(leaf.path, detail.form.editableFields) && editableValue(leaf.value, leaf.path),
    );
  const available = detail.actions.filter(
    (action): action is ApprovalAction => Object.hasOwn(actionLabels, action) && (action !== 'edit' || canEdit),
  );
  return (
    <section className="approval-actions" aria-label={text.action}>
      <h3>{text.action}</h3>
      <div className="approval-button-row">
        {available.map((action) => (
          <button
            key={action}
            type="button"
            disabled={command.busy || command.mode === 'unknown'}
            aria-pressed={command.action === action}
            onClick={() => command.selectAction(action)}
          >
            {actionLabels[action]}
          </button>
        ))}
      </div>
      {command.message && (
        <p role="status" className="transfer-notice">
          {command.message}
        </p>
      )}
      {command.mode === 'unknown' ? (
        <UnknownCommand command={command} />
      ) : (
        command.action && (
          <form
            className="approval-action-form"
            onSubmit={(event) => {
              event.preventDefault();
              command.submit();
            }}
          >
            <ActionInputs detail={detail} command={command} />
            <button
              type="submit"
              disabled={
                command.busy || !available.includes(command.action) || (command.mode === 'conflict' && !command.checked)
              }
            >
              {command.mode === 'conflict' ? text.resubmitConfirm : text.submit}
            </button>
            {command.mode === 'conflict' && !command.checked && (
              <button type="button" onClick={() => void command.recheck()}>
                {text.recheck}
              </button>
            )}
          </form>
        )
      )}
    </section>
  );
}
function UnknownCommand({ command }: { command: Actions }) {
  return (
    <div className="approval-command-recovery">
      <p>
        {text.command}：{command.pending?.id}
      </p>
      <button type="button" disabled={command.busy} onClick={() => void command.recheck()}>
        {text.recheck}
      </button>
      <button
        type="button"
        disabled={command.busy || !command.checked || !command.pending}
        onClick={() => {
          if (command.pending) void command.execute(command.pending);
        }}
      >
        {text.retryOriginal}
      </button>
    </div>
  );
}
function ActionInputs({ detail, command }: { detail: ApprovalDetail; command: Actions }) {
  const action = command.action!;
  const update = (patch: Partial<ActionDraft>) => command.setDraft((draft) => ({ ...draft, ...patch }));
  const comments = ['approve', 'disagree', 'reject', 'transfer', 'addSign', 'cc'].includes(action);
  return (
    <fieldset disabled={command.busy}>
      <legend>{actionLabels[action]}</legend>
      {comments && (
        <label>
          {text.comment}
          <textarea
            aria-label={text.comment}
            rows={3}
            maxLength={2000}
            value={command.draft.comment}
            onChange={(event) => update({ comment: event.target.value })}
          />
          <span className="approval-hint">{detail.commentNotice}</span>
        </label>
      )}
      {action === 'reject' && <p className="approval-hint">{text.rejectHint}</p>}
      {action === 'transfer' && (
        <AccountInput value={command.draft.toUserId} onChange={(toUserId) => update({ toUserId })} />
      )}
      {['addSign', 'cc'].includes(action) && (
        <label>
          {text.users}
          <textarea
            aria-label={text.users}
            rows={3}
            value={command.draft.userIds}
            onChange={(event) => update({ userIds: event.target.value })}
          />
          <span className="approval-hint">{text.usersHint}</span>
        </label>
      )}
      {action === 'addSign' && (
        <label>
          {text.signType}
          <select
            aria-label={text.signType}
            value={command.draft.signType}
            onChange={(event) => update({ signType: event.target.value as ActionDraft['signType'] })}
          >
            {allowedAddSignTypes(detail).map((type) => (
              <option key={type} value={type}>
                {text[type]}
              </option>
            ))}
          </select>
          <span className="approval-hint">{text.signHint}</span>
        </label>
      )}
      {['adminTransfer', 'adminIntervene'].includes(action) && (
        <AdminInputs draft={command.draft} intervene={action === 'adminIntervene'} update={update} />
      )}
    </fieldset>
  );
}
function AccountInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label>
      {text.toUser}
      <input
        aria-label={text.toUser}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
      />
      <span className="approval-hint">{text.userHint}</span>
    </label>
  );
}
function AdminInputs({
  draft,
  intervene,
  update,
}: {
  draft: ActionDraft;
  intervene: boolean;
  update: (patch: Partial<ActionDraft>) => void;
}) {
  const jump = intervene && draft.adminKind === 'jump';
  return (
    <div className="approval-form-grid">
      {intervene && (
        <label>
          {text.adminKind}
          <select
            aria-label={text.adminKind}
            value={draft.adminKind}
            onChange={(event) => update({ adminKind: event.target.value as ActionDraft['adminKind'] })}
          >
            <option value="reassign">{text.reassign}</option>
            <option value="jump">{text.jump}</option>
          </select>
        </label>
      )}
      {jump ? (
        <label>
          {text.targetNode}
          <input
            aria-label={text.targetNode}
            maxLength={40}
            value={draft.nodeKey}
            onChange={(event) => update({ nodeKey: event.target.value })}
          />
        </label>
      ) : (
        <>
          <label>
            {text.task}
            <input
              aria-label={text.task}
              value={draft.taskId}
              onChange={(event) => update({ taskId: event.target.value })}
              autoComplete="off"
            />
          </label>
          <AccountInput value={draft.toUserId} onChange={(toUserId) => update({ toUserId })} />
        </>
      )}
      <label>
        {text.reason}
        <textarea
          aria-label={text.reason}
          rows={3}
          maxLength={500}
          value={draft.reason}
          onChange={(event) => update({ reason: event.target.value })}
        />
      </label>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { ApprovalApiError, executeApprovalCommand, permissionFailure, requestMessage, unknownResult } from './api.js';
import { initialActionDraft, makeApprovalCommand } from './commands.js';
import { editableLeaf, fieldLeaves } from './fields.js';
import { text } from './messages.js';
import type { ActionDraft, ApprovalAction, ApprovalCommand, ApprovalDetail, FieldDraft } from './types.js';

interface CommandProps {
  readonly tenantId: string;
  readonly detail: ApprovalDetail;
  readonly onResult: (detail: ApprovalDetail) => void;
  readonly refresh: () => Promise<ApprovalDetail>;
  readonly onDenied: () => void;
  readonly onDone: () => void;
}
function disclosedDraft(detail: ApprovalDetail, draft: FieldDraft): FieldDraft {
  const visible = new Set(
    fieldLeaves(detail.form.values)
      .filter((leaf) => editableLeaf(leaf.path, detail.form.editableFields))
      .map((leaf) => JSON.stringify(leaf.path)),
  );
  return Object.fromEntries(Object.entries(draft).filter(([key]) => visible.has(key)));
}
export function useApprovalCommand(props: CommandProps) {
  const [action, setAction] = useState<ApprovalAction | null>(null);
  const [draft, setDraft] = useState<ActionDraft>(() => initialActionDraft(props.detail));
  const [fields, setFields] = useState<FieldDraft>({});
  useEffect(() => setFields((old) => disclosedDraft(props.detail, old)), [props.detail]);
  const reset = () => {
    setAction(null);
    setFields({});
    setDraft(initialActionDraft(props.detail));
  };
  const recovery = useCommandRecovery({
    ...props,
    reset,
    prune: (detail) => setFields((old) => disclosedDraft(detail, old)),
  });
  function selectAction(next: ApprovalAction) {
    if (recovery.busy || recovery.mode === 'unknown') return;
    setAction(next);
    setDraft(initialActionDraft(props.detail));
    recovery.resetMode();
  }
  function submit() {
    if (!action || recovery.busy) return;
    try {
      void recovery.execute(makeApprovalCommand(props.detail, action, draft, fields));
    } catch (failure) {
      recovery.setMessage(requestMessage(failure));
    }
  }
  return { action, draft, setDraft, fields, setFields, selectAction, submit, ...recovery };
}
interface RecoveryProps extends CommandProps {
  readonly reset: () => void;
  readonly prune: (detail: ApprovalDetail) => void;
}
function useMounted() {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return active;
}
function useCommandRecovery(props: RecoveryProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'normal' | 'conflict' | 'unknown'>('normal');
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState<ApprovalCommand | null>(null);
  const active = useMounted();
  const busyRef = useRef(false);
  function denied() {
    props.reset();
    setPending(null);
    setMode('normal');
    props.onDenied();
    setMessage(text.forbidden);
  }
  async function recheck(nextMode = mode) {
    try {
      const fresh = await props.refresh();
      if (!active.current) return;
      props.prune(fresh);
      setChecked(true);
      setMessage(nextMode === 'unknown' ? text.unknown : text.conflict);
    } catch (failure) {
      if (!active.current) return;
      if (permissionFailure(failure)) return denied();
      setChecked(false);
      setMessage(nextMode === 'unknown' ? text.unknownUnread : text.conflictUnread);
    }
  }
  async function execute(command: ApprovalCommand) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await executeApprovalCommand(props.tenantId, command);
      if (!active.current) return;
      props.onResult(result);
      props.reset();
      setPending(null);
      setMode('normal');
      setMessage(text.succeeded);
      props.onDone();
    } catch (failure) {
      if (!active.current) return;
      if (permissionFailure(failure)) denied();
      else if (failure instanceof ApprovalApiError && failure.status === 409) {
        setPending(null);
        setMode('conflict');
        setChecked(false);
        await recheck('conflict');
      } else if (unknownResult(failure)) {
        setPending(command);
        setMode('unknown');
        setChecked(false);
        await recheck('unknown');
      } else setMessage(requestMessage(failure));
    } finally {
      busyRef.current = false;
      if (active.current) setBusy(false);
    }
  }
  return {
    busy,
    message,
    setMessage,
    mode,
    checked,
    pending,
    execute,
    recheck,
    resetMode: () => {
      setMode('normal');
      setMessage('');
      setPending(null);
    },
  };
}

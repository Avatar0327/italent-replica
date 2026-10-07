import { useEffect, useRef, useState } from 'react';
import { executeApprovalCommand, permissionFailure, requestMessage, revisionConflict, unknownResult } from './api.js';
import { initialActionDraft, makeApprovalCommand } from './commands.js';
import { editableLeaf, fieldLeaves } from './fields.js';
import { text } from './messages.js';
import type { ActionDraft, ApprovalAction, ApprovalCommand, ApprovalDetail, FieldDraft } from './types.js';
import type { InstanceRequests } from './useApprovalInstance.js';

interface CommandProps {
  readonly tenantId: string;
  readonly detail: ApprovalDetail;
  /** 写请求发出时领取的代次随响应一起交回，由实例层裁决是否采用。 */
  readonly requests: Pick<InstanceRequests, 'issue' | 'settle'>;
  readonly onResult: (detail: ApprovalDetail, ticket: number) => void;
  /** 回查结果过期（更晚的响应已被采用）时返回 null。 */
  readonly refresh: () => Promise<ApprovalDetail | null>;
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
function recoveryMessage(mode: 'normal' | 'conflict' | 'unknown', readable: boolean, reason: string) {
  if (mode === 'unknown') return readable ? text.unknown : text.unknownUnread;
  return `${reason}${readable ? text.conflict : text.conflictUnread}`;
}
function useRecoveryState() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'normal' | 'conflict' | 'unknown'>('normal');
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState<ApprovalCommand | null>(null);
  const conflictReason = useRef('');
  function resetMode(message = '') {
    conflictReason.current = '';
    setPending(null);
    setMode('normal');
    setChecked(false);
    setMessage(message);
  }
  return {
    busy,
    setBusy,
    message,
    setMessage,
    mode,
    setMode,
    checked,
    setChecked,
    pending,
    setPending,
    conflictReason,
    resetMode,
  };
}
function useCommandRecovery(props: RecoveryProps) {
  const state = useRecoveryState();
  const { setBusy, setMessage, mode, setMode, setChecked, setPending, conflictReason, resetMode } = state;
  const active = useMounted();
  const busyRef = useRef(false);
  function denied(ticket?: number) {
    // 过期的写 403（更晚的响应已被采用）不清掉当前详情，改由服务端重新裁决。
    if (ticket !== undefined && !props.requests.settle(ticket)) {
      resetMode(text.forbidden);
      void props.refresh().catch(() => undefined);
      return;
    }
    props.reset();
    resetMode(text.forbidden);
    props.onDenied();
  }
  async function recheck(nextMode = mode) {
    try {
      const fresh = await props.refresh();
      if (!active.current || !fresh) return;
      props.prune(fresh);
      setChecked(true);
      setMessage(recoveryMessage(nextMode, true, conflictReason.current));
    } catch (failure) {
      if (!active.current) return;
      if (permissionFailure(failure)) return denied();
      setChecked(false);
      setMessage(recoveryMessage(nextMode, false, conflictReason.current));
    }
  }
  async function execute(command: ApprovalCommand) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const ticket = props.requests.issue();
    try {
      const result = await executeApprovalCommand(props.tenantId, command);
      if (!active.current) return;
      props.onResult(result, ticket);
      props.reset();
      resetMode(text.succeeded);
      props.onDone();
    } catch (failure) {
      if (!active.current) return;
      if (permissionFailure(failure)) denied(ticket);
      else if (revisionConflict(failure)) {
        conflictReason.current = failure.reason === 'APPROVAL_CONCURRENT_CONFLICT' ? `${requestMessage(failure)} ` : '';
        setPending(null);
        setMode('conflict');
        setChecked(false);
        await recheck('conflict');
      } else if (unknownResult(failure)) {
        setPending(command);
        setMode('unknown');
        setChecked(false);
        await recheck('unknown');
      } else resetMode(requestMessage(failure));
    } finally {
      busyRef.current = false;
      if (active.current) setBusy(false);
    }
  }
  return {
    busy: state.busy,
    message: state.message,
    setMessage,
    mode,
    checked: state.checked,
    pending: state.pending,
    execute,
    recheck,
    resetMode,
  };
}

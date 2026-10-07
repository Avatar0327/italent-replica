import { useEffect, useRef, useState } from 'react';
import { executeApprovalCommand, permissionFailure, requestMessage, revisionConflict, unknownResult } from './api.js';
import { initialActionDraft, makeApprovalCommand } from './commands.js';
import { editableLeaf, fieldLeaves } from './fields.js';
import { text } from './messages.js';
import { STALE } from './requestLane.js';
import type { ActionDraft, ApprovalAction, ApprovalCommand, ApprovalDetail, FieldDraft } from './types.js';
import type { InstanceRequests } from './useApprovalInstance.js';

interface CommandProps {
  readonly tenantId: string;
  /** 清空重读期间为 null：命令状态（幂等键、结果未知的提交）仍保留在本 hook（DEC-288 ①）。 */
  readonly detail: ApprovalDetail | null;
  /** 写请求与读取共用实例通道串行执行（DEC-277 ①）；403 作为收紧信号交实例层清空并重读（②）。 */
  readonly requests: InstanceRequests;
  /** 写响应是完整详情，由实例层整体替换。 */
  readonly onResult: (detail: ApprovalDetail) => void;
  /** 回查被通道重置丢弃时返回 null；被拒时实例层已清空并抛出。 */
  readonly refresh: () => Promise<ApprovalDetail | null>;
  readonly onDone: () => void;
}
/** 表单草稿只保留当前详情里仍可编辑且已披露的叶子。 */
export function disclosedDraft(detail: ApprovalDetail, draft: FieldDraft): FieldDraft {
  const visible = new Set(
    fieldLeaves(detail.form.values)
      .filter((leaf) => editableLeaf(leaf.path, detail.form.editableFields))
      .map((leaf) => JSON.stringify(leaf.path)),
  );
  return Object.fromEntries(Object.entries(draft).filter(([key]) => visible.has(key)));
}
/**
 * 命令状态挂在详情面板层（随单据打开 / 关闭存活），不随展示层按字段集合版本重建或清空重读而销毁（DEC-288 ①）。
 * 表单草稿（fields）属于展示缓存，由展示层自行持有。
 */
export function useApprovalCommand(props: CommandProps) {
  const [action, setAction] = useState<ApprovalAction | null>(null);
  const [draft, setDraft] = useState<ActionDraft>(() => initialActionDraft(props.detail));
  const reset = () => {
    setAction(null);
    setDraft(initialActionDraft(props.detail));
  };
  const recovery = useCommandRecovery({ ...props, reset });
  const { mode, markChecked } = recovery;
  // 清空重读只清展示缓存：未进入恢复流程时，动作选择与输入草稿随展示一起清空。
  useEffect(() => {
    if (!props.detail && mode === 'normal') {
      setAction(null);
      setDraft(initialActionDraft(null));
    }
  }, [props.detail, mode]);
  // DEC-288 ②：结果未知后，任一完整详情到达即视为已查询一次结果，允许沿原幂等键重试。
  useEffect(() => {
    if (props.detail && mode === 'unknown') markChecked();
    // 只在详情到达时触发；mode / markChecked 变化本身不代表新的查询结果。
  }, [props.detail]);
  function selectAction(next: ApprovalAction) {
    if (!props.detail || recovery.busy || mode === 'unknown') return;
    setAction(next);
    setDraft(initialActionDraft(props.detail));
    recovery.resetMode();
  }
  function submit(fields: FieldDraft) {
    if (!action || !props.detail || recovery.busy) return;
    try {
      void recovery.execute(makeApprovalCommand(props.detail, action, draft, fields));
    } catch (failure) {
      recovery.setMessage(requestMessage(failure));
    }
  }
  return { action, draft, setDraft, selectAction, submit, ...recovery };
}
export type CommandState = ReturnType<typeof useApprovalCommand>;
/** 展示层把表单草稿绑定进 submit 后交给动作面板。 */
export type CommandView = Omit<CommandState, 'submit'> & { readonly submit: () => void };
interface RecoveryProps extends CommandProps {
  readonly reset: () => void;
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
  function markChecked() {
    setChecked(true);
    setMessage(recoveryMessage('unknown', true, ''));
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
    markChecked,
  };
}
function useCommandRecovery(props: RecoveryProps) {
  const state = useRecoveryState();
  const { setBusy, setMessage, mode, setMode, setChecked, setPending, conflictReason, resetMode } = state;
  const { markChecked } = state;
  const active = useMounted();
  const busyRef = useRef(false);
  function denied() {
    props.reset();
    resetMode(text.forbidden);
  }
  async function recheck(nextMode = mode) {
    try {
      const fresh = await props.refresh();
      if (!active.current || !fresh) return;
      setChecked(true);
      setMessage(recoveryMessage(nextMode, true, conflictReason.current));
    } catch {
      // 回查被拒时实例层已清空并关闭该单，这里只处理其他读取失败。
      if (!active.current) return;
      setChecked(false);
      setMessage(recoveryMessage(nextMode, false, conflictReason.current));
    }
  }
  async function execute(command: ApprovalCommand) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      // DEC-277 ②：写被拒是收紧信号，在通道任务内即清空草稿并由实例层整页重读；本次结果随之作废。
      const result = await props.requests.run(async (signal) => {
        try {
          return await executeApprovalCommand(props.tenantId, command, signal);
        } catch (failure) {
          if (active.current && permissionFailure(failure)) {
            denied();
            props.requests.tighten();
          }
          throw failure;
        }
      });
      if (!active.current || result === STALE) return;
      props.onResult(result);
      props.reset();
      resetMode(text.succeeded);
      props.onDone();
    } catch (failure) {
      if (!active.current) return;
      if (revisionConflict(failure)) {
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
    markChecked,
  };
}

// F-326 S7b（主设计 §5.5 ④⑦）：设计器发布。经 F-123 内核（If-Match 流程版本 + 幂等键），与保存共用恢复槽、
// 动作记 publish：发布结果未知时保存也锁定。被拒后清掉原命令，重新发布换新命令 ID（DEC-067 不盲重试）。
// - 指定人员未选择（400 APPROVAL_SPECIFIED_APPROVER_REQUIRED）：按 details.slots 交给页面标出节点；
// - 待生效冲突（409 APPROVAL_PENDING_VARIABLE_CONFLICT）：弹窗逐个选“设计器值 / 变量页当前值”，带 pendingResolutions 重发。
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Modal, Radio, Typography } from 'antd';
import { rejectionMessage } from '../../foundation/client.js';
import { useApiClient } from '../../foundation/Session.js';
import { CommandStatus } from '../../foundation/forms/CommandStatus.js';
import { useConflictCommand, type Sending } from '../../foundation/forms/ConflictCommands.js';
import type { CommandForm } from '../../foundation/forms/useCommandForm.js';
import type { Values } from '../../foundation/forms/values.js';
import { readProcess } from './api.js';
import { useDesignerPeople } from './FallbackHandlers.js';
import { base, validProcess, type ProcessView } from './model.js';
import { m } from './messages.js';
import { p } from './publish-messages.js';
import { s } from './source-messages.js';
import { DesignerError, useDesignerRequest } from './write.js';

export interface MissingSlot {
  nodeKey: string;
  nodeName: string;
  slot: string;
}
interface PendingConflict {
  variableId: string;
  code: string;
  name: string;
  revision: number;
  designerUserIds: string[];
  currentUserIds: string[];
}
const CHOICES = ['designer', 'current'] as const;
type Choice = (typeof CHOICES)[number];
const isChoice = (value: unknown): value is Choice => CHOICES.some((choice) => choice === value);
interface Resolution {
  variableId: string;
  revision: number;
  choice: Choice;
}
/** 本次发布的目标版本：记进命令基线（随恢复槽保存），结果未知退出重开后仍按它显示与回查。 */
interface Target {
  id: string;
  versionNo: number;
}
const texts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const entries = (value: unknown) =>
  (Array.isArray(value) ? value : []).filter((item): item is Values => !!item && typeof item === 'object');
const slotsOf = (details: Values): MissingSlot[] =>
  entries(details.slots).filter((item): item is Values & MissingSlot =>
    ['nodeKey', 'nodeName', 'slot'].every((k) => typeof item[k] === 'string'),
  );
const conflictsOf = (details: Values): PendingConflict[] =>
  entries(details.conflicts).filter(
    (item): item is Values & PendingConflict =>
      ['variableId', 'code', 'name'].every((k) => typeof item[k] === 'string') &&
      Number.isSafeInteger(item.revision) &&
      texts(item.designerUserIds) &&
      texts(item.currentUserIds),
  );
/** 原命令体里发出的待生效选择（内核随恢复槽保存，退出重开后仍在）；形状不符的条目丢弃，由服务端再问。 */
const resolutionsOf = (body: Values | undefined): Resolution[] =>
  entries(body?.pendingResolutions).flatMap((item) =>
    typeof item.variableId === 'string' && Number.isSafeInteger(item.revision) && isChoice(item.choice)
      ? [{ variableId: item.variableId, revision: item.revision as number, choice: item.choice }]
      : [],
  );
const targetOf = (values: Values | undefined) => values?.$target as Target | undefined;
/** 目标版本在读回详情里的状态：是最新版本或生效版本就取其状态；都不是（已被别的版本取代）为 null。 */
const statusOf = (latest: ProcessView, target: Target) =>
  [latest.latestVersion, latest.currentVersion].find((version) => version?.id === target.id)?.status ?? null;
const statusText = (status: unknown) =>
  ({ draft: m.draft, published: m.published, discarded: m.discarded })[String(status)] ?? p.targetMissing;
/** 回执绑定本次版本且最新版本已发布；形状不符由内核按结果未知锁定。 */
function acceptPublished(value: unknown, id: string, revision: number) {
  if (!validProcess(value, id) || value.revision <= revision || value.latestVersion.status !== 'published')
    throw new Error(m.invalidReceipt);
  return value;
}
function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
/**
 * 待生效冲突的弹窗与仍有效的选择（P2-1 单一入口）：只在发布被拒时由 settle 按被拒原命令体恢复，发布成功、取消、
 * 版本冲突重读后由 forget 清空。新发起与按原单重发（可能已退出重开、组件内存已没有当初的选择）走同一条路。
 */
function usePendingChoices(mounted: { current: boolean }) {
  const kept = useRef<Resolution[]>([]);
  const [conflicts, setConflicts] = useState<PendingConflict[]>();
  const forget = () => {
    kept.current = [];
    if (mounted.current) setConflicts(undefined);
  };
  /** 服务端报告过期的项重选，其余仍有效的保留（确认时一并发出）；没有待生效冲突就清空。返回是否要重选。 */
  const settle = (sent: Resolution[], pending: PendingConflict[]) => {
    if (!pending.length) {
      forget();
      return false;
    }
    kept.current = sent.filter((item) => !pending.some((conflict) => conflict.variableId === item.variableId));
    setConflicts(pending);
    return true;
  };
  return { kept, conflicts, forget, settle };
}
interface PublishHandlers {
  onMissing(slots: MissingSlot[]): void;
  onDone(): void;
  /** 版本冲突重读核对后重新读取页面，让用户先看到最新草稿再决定是否发布。 */
  onRefresh(): void;
}

export function usePublish(process: ProcessView, handlers: PublishHandlers) {
  const api = useApiClient();
  const request = useDesignerRequest();
  // 发起请求的流程 / 版本 / 视图：本组件随它们卸载（Definition 以版本为 key、切到生效版本视图也卸载）
  const mounted = useMounted();
  const snapshot = {
    id: process.id,
    revision: process.revision,
    values: { $target: { id: process.latestVersion.id, versionNo: process.latestVersion.versionNo } },
  };
  const read = async () => {
    const latest = await readProcess(api, process.id);
    const target = targetOf(command.form.state?.baseline) ?? snapshot.values.$target;
    return { id: latest.id, revision: latest.revision, values: { $status: statusOf(latest, target) } };
  };
  const command = useConflictCommand(base, snapshot, read, { action: 'publish' });
  const [error, setError] = useState<string>();
  const choices = usePendingChoices(mounted);
  const path = `${base}/${encodeURIComponent(process.id)}/publish`;
  // 请求体就是内核保存的命令体：结果未知时按原单重发同键同体
  const send = async ({ command: sending }: Sending) =>
    acceptPublished(await request(path, 'POST', sending), process.id, sending.revision!);
  const finish = () => {
    choices.forget();
    // 迟到的成功回执：命令已由内核落定，但用户已离开发起它的流程 / 版本 / 视图时不刷新页面（P2-5）
    if (mounted.current) handlers.onDone();
  };
  const fail = (failure: unknown) => {
    const state = command.form.peek();
    // 结果未知与版本冲突由内核锁定并提示（回查 / 重读），不在这里清掉原命令
    if (state?.status === 'unknown' || state?.status === 'conflict') return;
    // 发出过的选择从刚被拒的原命令体取：按原单重发时本组件可能已退出重开，内存里没有当初的选择（P2-1）
    const sent = resolutionsOf(state?.command?.body);
    command.form.clear();
    if (!mounted.current) return;
    const details = failure instanceof DesignerError ? failure.details : {};
    const pending = details.reason === 'APPROVAL_PENDING_VARIABLE_CONFLICT' ? conflictsOf(details) : [];
    if (choices.settle(sent, pending)) return;
    if (details.reason === 'APPROVAL_SPECIFIED_APPROVER_REQUIRED') handlers.onMissing(slotsOf(details));
    setError(rejectionMessage(failure));
  };
  const run = async (chosen?: Resolution[]) => {
    const resolutions = chosen ? [...choices.kept.current, ...chosen] : [];
    setError(undefined);
    handlers.onMissing([]);
    const values = resolutions.length ? { pendingResolutions: resolutions } : {};
    try {
      await command.run({ values, editableFields: Object.keys(values), send });
      finish();
    } catch (failure) {
      fail(failure);
    }
  };
  /** 结果未知：用户回查后显式按原单重发（同一 Idempotency-Key 与请求体），不另起命令。 */
  const replay = async () => {
    try {
      await command.replay(send);
      finish();
    } catch (failure) {
      fail(failure);
    }
  };
  const reread = command.form.reload;
  const reload =
    reread &&
    (async () => {
      await reread();
      const state = command.form.peek();
      if (state?.status !== 'conflict' || !state.latest || state.readError) return;
      // 版本冲突（P1-1）：不直接发布页面没展示过的草稿，落定失败后重读页面；旧草稿上的待生效选择不带过去，由服务端再问
      command.form.confirm();
      command.form.clear();
      choices.forget();
      if (mounted.current) handlers.onRefresh();
    });
  const form: CommandForm = { ...command.form, reload };
  return { form, run, replay, error, conflicts: choices.conflicts, cancel: choices.forget };
}
type Publish = ReturnType<typeof usePublish>;

export function PublishStatus({ publish }: { publish: Publish }) {
  const state = publish.form.state;
  const target = targetOf(state?.baseline);
  const unknown = state?.status === 'unknown';
  // 结果未知的回查只是目标版本的当前状态，不是原命令回执：通用核对表换成下面一行状态（P2-2）
  const submission = unknown ? { ...publish.form, state: { ...state, latest: undefined } } : publish.form;
  return (
    <>
      <CommandStatus submission={submission} />
      {unknown && target && (
        <Alert
          type="info"
          message={p.target(target.versionNo)}
          description={state.latest && p.targetStatus(statusText(state.latest.values.$status))}
          action={
            <Button
              disabled={!state.latest || state.reading || !!state.readError}
              onClick={() => void publish.replay()}
            >
              {p.replay}
            </Button>
          }
        />
      )}
      {publish.error && <Alert type="error" showIcon message={publish.error} />}
      {publish.conflicts && (
        <PendingConflicts conflicts={publish.conflicts} publish={publish} busy={publish.form.busy} />
      )}
    </>
  );
}
/** 草稿有未保存的修改时不发布：发布的是服务端草稿，先保存才能发布页面上看到的内容。 */
export function PublishButton({
  publish,
  unsaved,
  disabled,
}: {
  publish: Publish;
  /** 实际可提交值与服务端草稿有差异（改了又改回原值不算）。 */
  unsaved(): boolean;
  disabled: boolean;
}) {
  const [dirty, setDirty] = useState(false);
  const start = () => {
    const changed = unsaved();
    setDirty(changed);
    if (!changed) void publish.run();
  };
  return (
    <>
      <Button
        aria-label={p.publish}
        loading={publish.form.busy}
        disabled={disabled || publish.form.locked || !!publish.form.blocked}
        onClick={start}
      >
        {p.publish}
      </Button>
      {dirty && <Alert type="warning" showIcon message={p.dirty} />}
    </>
  );
}

function PendingConflicts({
  conflicts,
  publish,
  busy,
}: {
  conflicts: PendingConflict[];
  publish: Publish;
  busy: boolean;
}) {
  const { known } = useDesignerPeople([
    ...new Set(conflicts.flatMap((c) => [...c.designerUserIds, ...c.currentUserIds])),
  ]);
  // 选择绑定变量版本：再次 409（选后变量又被改）时换成新条目，必须重新选
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const keyOf = (item: PendingConflict) => `${item.variableId}@${item.revision}`;
  const names = (ids: string[]) =>
    ids.length
      ? ids.map((id) => known?.choices.find((c) => c.value === id)?.label ?? s.personUnavailable).join('、')
      : s.unselected;
  const ready = conflicts.every((item) => choices[keyOf(item)]);
  const confirm = () =>
    void publish.run(
      conflicts.map((item) => ({
        variableId: item.variableId,
        revision: item.revision,
        choice: choices[keyOf(item)]!,
      })),
    );
  return (
    <Modal
      open
      title={p.conflictTitle}
      okText={p.confirm}
      cancelText={p.cancel}
      okButtonProps={{ disabled: !ready, loading: busy }}
      onOk={confirm}
      onCancel={publish.cancel}
    >
      <p>{p.conflictHint}</p>
      {conflicts.map((item) => (
        <section key={keyOf(item)} className="flow-pending-conflict">
          <Typography.Text strong>{item.name}</Typography.Text>{' '}
          <Typography.Text type="secondary">{item.code}</Typography.Text>
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'designer', label: p.designerValue, children: names(item.designerUserIds) },
              { key: 'current', label: p.currentValue, children: names(item.currentUserIds) },
            ]}
          />
          <Radio.Group
            value={choices[keyOf(item)]}
            onChange={(event) => setChoices({ ...choices, [keyOf(item)]: event.target.value as Choice })}
            options={[
              { value: 'designer', label: p.chooseDesigner },
              { value: 'current', label: p.chooseCurrent },
            ]}
          />
        </section>
      ))}
    </Modal>
  );
}

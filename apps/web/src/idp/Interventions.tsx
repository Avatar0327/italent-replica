import { Alert, Button, Form, Input, Modal, Radio, Select, Space } from 'antd';
import { useState, type ReactNode } from 'react';
import { IDP_API, useAction } from './api.js';
import { ActionError } from './listing.js';
import { t } from './messages.js';
import { batchSplit, receiptSummary, type BatchAction } from './model.js';
import { useRead } from '../evaluation/runtime.js';
import type { ApprovalCandidate, PlanSummary, Process, Receipt } from './types.js';

export type InterventionKind = BatchAction | 'start' | 'jump' | 'transfer' | 'delete';
interface Props {
  kind: InterventionKind;
  rows: PlanSummary[];
  onClose(): void;
  /** 写入完成（含部分成功）后刷新列表 / 详情。 */
  done(): void;
}
const TITLES: Record<InterventionKind, string> = {
  start: t.actions.start,
  urge: t.actions.urge,
  startNext: t.actions.startNext,
  terminate: t.actions.terminate,
  jump: t.actions.jump,
  transfer: t.actions.transfer,
  delete: t.actions.delete,
};

/** 计划状态动作与流程干预的统一弹窗；一次只提交一次，结果未知时锁定并要求刷新（AGENTS.md §10）。 */
export function Intervention({ kind, rows, onClose, done }: Props) {
  const action = useAction(done);
  const [receipts, setReceipts] = useState<Receipt[]>();
  const failure = action.error ? (
    <ActionError error={action.error} reset={action.blocked ? action.reset : undefined} />
  ) : null;
  if (receipts) {
    const summary = receiptSummary(receipts);
    return (
      <Modal open title={TITLES[kind]} onCancel={onClose} footer={<Button onClick={onClose}>{t.actions.back}</Button>}>
        <Alert
          type={summary.failed ? 'warning' : 'success'}
          showIcon
          message={t.receipts(summary.done, summary.failed)}
        />
      </Modal>
    );
  }
  const props = { rows, onClose, action, failure, finish: setReceipts };
  if (kind === 'jump') return <JumpDialog {...props} />;
  if (kind === 'transfer') return <TransferDialog {...props} />;
  if (kind === 'start' || kind === 'delete') return <SingleConfirm kind={kind} {...props} />;
  return <BatchDialog kind={kind} {...props} />;
}

interface DialogProps {
  rows: PlanSummary[];
  onClose(): void;
  action: ReturnType<typeof useAction>;
  failure: ReactNode;
  finish(receipts: Receipt[]): void;
}
function footer(onClose: () => void, ok: () => void, disabled: boolean, busy: boolean) {
  return (
    <Space>
      <Button onClick={onClose} disabled={busy}>
        {t.actions.back}
      </Button>
      <Button type="primary" onClick={ok} disabled={disabled} loading={busy}>
        {t.actions.ok}
      </Button>
    </Space>
  );
}

function SingleConfirm({ kind, rows, onClose, action, failure }: DialogProps & { kind: 'start' | 'delete' }) {
  const plan = rows.length === 1 ? rows[0] : undefined;
  const ok = async () => {
    if (!plan || plan.revision === undefined) return;
    const path = kind === 'start' ? `${IDP_API}/plans/${plan.id}/start` : `${IDP_API}/plans/${plan.id}`;
    const result = await action.run(path, kind === 'start' ? 'POST' : 'DELETE', {}, plan.revision);
    if (result !== undefined) onClose();
  };
  return (
    <Modal
      open
      title={TITLES[kind]}
      onCancel={onClose}
      footer={footer(onClose, () => void ok(), !plan || action.blocked, action.busy)}
    >
      {failure}
      <p>{plan ? t.confirm[kind] : t.selectOne}</p>
    </Modal>
  );
}

function BatchDialog({ kind, rows, onClose, action, failure, finish }: DialogProps & { kind: BatchAction }) {
  const { eligible, skipped } = batchSplit(rows, kind);
  const [reason, setReason] = useState('');
  const [runningMode, setRunningMode] = useState<'skipRunning' | 'endRunning'>('skipRunning');
  const ok = async () => {
    const items = eligible.map((row) => ({ id: row.id, revision: row.revision! }));
    const note = kind === 'terminate' && reason.trim() ? { reason: reason.trim() } : {};
    const body = kind === 'startNext' ? { items, runningMode } : { items, ...note };
    const path = { urge: 'urge', startNext: 'start-next', terminate: 'terminate' }[kind];
    const result = await action.batch(`${IDP_API}/plans/${path}`, body);
    if (result) finish(result.receipts);
  };
  return (
    <Modal
      open
      title={TITLES[kind]}
      onCancel={onClose}
      footer={footer(onClose, () => void ok(), !eligible.length || action.blocked, action.busy)}
    >
      {failure}
      {skipped.length > 0 && <Alert type="warning" showIcon message={t.skipped(skipped.length)} />}
      {!eligible.length ? (
        <p>{t.noneEligible}</p>
      ) : (
        <>
          {kind !== 'urge' && <p>{t.confirm[kind]}</p>}
          {kind === 'startNext' && (
            <Form layout="vertical">
              <Form.Item label={t.runningModeLabel}>
                <Radio.Group value={runningMode} onChange={(event) => setRunningMode(event.target.value)}>
                  <Space direction="vertical">
                    <Radio value="skipRunning">{t.runningModes.skipRunning}</Radio>
                    <Radio value="endRunning">{t.runningModes.endRunning}</Radio>
                  </Space>
                </Radio.Group>
              </Form.Item>
            </Form>
          )}
          {kind === 'terminate' && (
            <Input.TextArea
              aria-label={t.terminateReason}
              placeholder={t.terminateReason}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
          <p className="idp-muted">{t.total(eligible.length)}</p>
        </>
      )}
    </Modal>
  );
}

/** 跳转节点来自当前阶段子流程关联的审批流程；任一环节读不到就不给提交，不猜节点。 */
function JumpDialog({ rows, onClose, action, failure }: DialogProps) {
  const plan = rows.length === 1 ? rows[0] : undefined;
  const stage = plan?.stages?.find((item) => item.status === 'running');
  const process = useRead<Process>(plan?.processId && stage ? `${IDP_API}/processes/${plan.processId}` : undefined);
  const sub = process.data?.subProcesses?.find((item) => item.id === stage?.subProcessId);
  const catalog = useRead<{ items: ApprovalCandidate[] }>(
    sub?.approvalType
      ? `${IDP_API}/approval-processes?approvalType=${encodeURIComponent(sub.approvalType)}`
      : undefined,
  );
  const nodes = catalog.data?.items.find((item) => item.id === sub?.approvalProcessId)?.nodes ?? [];
  const [form] = Form.useForm<{ toNodeKey: string; reason: string }>();
  const loading = process.loading || catalog.loading;
  const failed = !plan || !stage || !plan.processId || !!process.error || !!catalog.error || (!!process.data && !sub);
  const ok = async () => {
    const values = await form.validateFields();
    const result = await action.run(
      `${IDP_API}/plans/${plan!.id}/jump`,
      'POST',
      { toNodeKey: values.toNodeKey, stageId: stage!.id, reason: values.reason.trim() },
      plan!.revision!,
    );
    if (result !== undefined) onClose();
  };
  return (
    <Modal
      open
      title={TITLES.jump}
      onCancel={onClose}
      footer={footer(onClose, () => void ok(), failed || loading || !nodes.length || action.blocked, action.busy)}
    >
      {failure}
      {!plan ? (
        <p>{t.selectOne}</p>
      ) : failed ? (
        <Alert type="error" showIcon message={t.nodeLoadFailed} />
      ) : (
        <>
          {!loading && catalog.data && !nodes.length && <Alert type="warning" showIcon message={t.noNodes} />}
          <Form form={form} layout="vertical">
            <Form.Item name="toNodeKey" label={t.jumpNode} rules={[{ required: true, message: t.required }]}>
              <Select
                loading={loading}
                options={[...nodes]
                  .sort((a, b) => a.seq - b.seq)
                  .map((node) => ({ value: node.nodeKey, label: node.name }))}
              />
            </Form.Item>
            <Form.Item
              name="reason"
              label={t.jumpReason}
              rules={[{ required: true, whitespace: true, message: t.required }]}
            >
              <Input.TextArea maxLength={500} />
            </Form.Item>
          </Form>
        </>
      )}
    </Modal>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 转交对象是用户 ID（后端契约 toUserId）；用户选择器接口未提供，暂以 ID 输入（后端缺口清单）。 */
function TransferDialog({ rows, onClose, action, failure }: DialogProps) {
  const plan = rows.length === 1 ? rows[0] : undefined;
  const [form] = Form.useForm<{ toUserId: string; reason?: string }>();
  const ok = async () => {
    const values = await form.validateFields();
    const reason = values.reason?.trim();
    const result = await action.run(
      `${IDP_API}/plans/${plan!.id}/transfer`,
      'POST',
      { toUserId: values.toUserId.trim(), ...(reason ? { reason } : {}) },
      plan!.revision!,
    );
    if (result !== undefined) onClose();
  };
  return (
    <Modal
      open
      title={TITLES.transfer}
      onCancel={onClose}
      footer={footer(onClose, () => void ok(), !plan || action.blocked, action.busy)}
    >
      {failure}
      {!plan ? (
        <p>{t.selectOne}</p>
      ) : (
        <Form form={form} layout="vertical">
          <Form.Item
            name="toUserId"
            label={t.transferTo}
            rules={[{ required: true, pattern: UUID, message: t.userIdRule }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="reason" label={t.transferReason}>
            <Input.TextArea maxLength={500} />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}

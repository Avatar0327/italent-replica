import { Button, Form, Input, Space, Tag, Typography, type FormInstance } from 'antd';
import { useEffect, useState } from 'react';
import { acceptReceipt, approvalRequest, readApproval } from '../approval/api.js';
import { useApprovalCommand } from '../approval/commands.js';
import type { ApprovalDetail } from '../approval/types.js';
import { myPendingTask } from '../contracts/forms.js';
import { forAction } from '../foundation/forms/action.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import { slotContext } from '../foundation/forms/store.js';
import { useCommandForm, useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { rereadReceipt, saveReceipt } from './access.js';
import { IDP_API } from './api.js';
import { t } from './messages.js';
import {
  codepoints,
  display,
  REVIEW_FIELDS,
  REVIEW_MAX,
  reviewTooLong,
  stageReview,
  type ReviewValues,
} from './model.js';
import type { PlanDetail, PlanModule, Stage } from './types.js';
import { useNames } from './useNames.js';

const LABELS = { summary: t.review.summary, improvement: t.review.improvement };
const APPROVAL_INSTANCES = '/api/tenant/approval/instances';

/** 与后端同口径按码点计长，超长前端拦下不发请求。 */
const lengthRule = (field: keyof ReviewValues) => ({
  validator: (_: unknown, value: string | null | undefined) =>
    reviewTooLong({ [field]: value }).length
      ? Promise.reject(new Error(t.reviewForm.tooLong(REVIEW_MAX)))
      : Promise.resolve(),
});

/**
 * 回顾保存：F-142 提交内核，回顾写的是计划（带计划 revision），命令放在计划的恢复槽，动作记“回顾 + 模块”，
 * 阶段作为命令上下文存进槽里（F-147）；冲突按计划详情重读后由内核回填。保存是草稿，两项可以先空着。
 */
function useReviewSave(props: ReviewProps, form: FormInstance<ReviewValues>) {
  const { plan, module, saved } = props;
  const api = useApiClient();
  const command = forAction(useCommandForm(slotKey(`${IDP_API}/plans`, plan.id)), {
    action: 'review',
    moduleId: module.id,
  });
  // 未完成的命令沿用它当初的阶段；阶段已切换时提交仍按原阶段核对（后端按当前阶段复核，变了会拒绝）。
  const stageId = slotContext<{ stageId: string }>(command.state)?.stageId ?? props.stage.id!;
  const baseline = stageReview(plan, module.id, stageId);
  useDraftRefill(command, REVIEW_FIELDS, form);
  const path = `${IDP_API}/plans/${plan.id}/modules/${module.id}/content`;
  const reload = () =>
    command.reread(async (id) => {
      const row = await api.request<PlanDetail>(`${IDP_API}/plans/${id ?? plan.id}`);
      return { ...rereadReceipt(row, plan.id), values: stageReview(row, module.id, stageId) };
    });
  const save = async (values: ReviewValues) => {
    if (command.locked) return false;
    if (command.status === 'rejected' || command.status === 'done') command.clear();
    const result = await command.submit({
      values: { ...baseline, ...values },
      baseline,
      editableFields: REVIEW_FIELDS,
      revision: plan.revision!,
      businessId: plan.id,
      patchOnly: true,
      context: { stageId },
      // 回执是完整计划详情：同一计划且版本前进才算保存成功，否则按结果未知锁定（F-164 第 1 轮 P2-3）
      send: async (request) =>
        saveReceipt(
          await api.request<PlanDetail>(path, { method: 'PUT', command: request }),
          plan.id,
          request.revision,
        ),
    });
    if (result.status === 'done') saved();
    return result.status === 'done';
  };
  return { command: { ...command, reload }, baseline, save };
}

/** 本人在该实例上可以“同意”的在办待办；不在回顾节点、不是处理人、已提交时没有。 */
const approvableTask = (detail: ApprovalDetail, userId: string | undefined) =>
  detail.actions.includes('approve') ? myPendingTask(detail, userId) : undefined;

/**
 * 回顾提交 = 同意本人在本阶段审批实例上的待办（POST /approval/tasks/:taskId/approve，If-Match 实例 revision）。
 * 命令放在流程实例的恢复槽（审批模块级存储，与审批详情、合同催办共用，F-147），动作与待办记在槽上下文；
 * 回执须是本实例且版本前进（acceptReceipt）。先读实例：本人没有可同意的待办就不给提交入口（`ready` 为假）。
 * approve 返回要提示的文案（点击时实例已变、没有本人待办），成功或交给内核显示状态时返回空。
 */
function useReviewApproval(instanceId: string | undefined, version: unknown, saved: () => void) {
  const api = useApiClient();
  const session = useSession();
  const approval = forAction(useApprovalCommand(slotKey(APPROVAL_INSTANCES, instanceId)), { action: 'approve' });
  const [task, setTask] = useState<string>();
  useEffect(() => {
    let live = true;
    const settle = (id?: string) => live && setTask(id);
    if (!instanceId) settle();
    else
      readApproval(api, instanceId).then(
        (detail) => settle(approvableTask(detail, session.userId)),
        () => settle(),
      );
    return () => {
      live = false;
    };
    // 计划刷新、本命令状态变化（同意完成后清掉）时重读，已提交的待办随之收起入口
  }, [api, instanceId, session.userId, version, approval.status]);
  const reload = () =>
    approval.reread(async (id) => {
      const detail = await readApproval(api, String(id ?? instanceId));
      return { id: detail.id, revision: detail.revision, values: {} };
    });
  const send = (detail: ApprovalDetail, taskId: string) =>
    approval.submit({
      values: {},
      baseline: {},
      editableFields: [],
      revision: detail.revision,
      businessId: detail.id,
      context: { taskId },
      send: async (sent) => {
        const request = approvalRequest(detail, 'approve', taskId, sent.body);
        const receipt = await api.request<unknown>(request.path, {
          method: 'POST',
          command: { ...sent, body: request.body },
        });
        return acceptReceipt(receipt, detail.id, sent.revision ?? detail.revision);
      },
    });
  const approve = async (): Promise<string | undefined> => {
    const detail = instanceId ? await readApproval(api, instanceId).catch(() => undefined) : undefined;
    if (!detail) return t.reviewForm.readFailed;
    const taskId = approvableTask(detail, session.userId);
    if (!taskId) return t.reviewForm.noTask;
    if (approval.status === 'rejected' || approval.status === 'done') approval.clear();
    if ((await send(detail, taskId)).status !== 'done') return undefined;
    approval.clear();
    saved();
  };
  // 命令未确认（处理中、结果未知、冲突）时入口保留并锁定，不因待办状态变化而消失
  const ready = !!task || approval.status !== 'idle';
  return { approval: { ...approval, reload }, approve, ready };
}

/** 提交时的必填：两项去空白后非空，口径与后端 409 IDP_REVIEW_REQUIRED 相同（approval-adapter requireReview）。 */
const missingReview = (values: ReviewValues) => REVIEW_FIELDS.filter((field) => !values[field]?.trim());

type ReviewProps = { plan: PlanDetail; module: PlanModule; stage: Stage; saved(): void };

/**
 * 当前阶段的回顾填写（原站 B4_26“总体回顾”；F-155b）：总结、改进方法两个多行框，各 ≤1000 字，右下角计数。
 * 保存可以留空；提交时前端先查两项非空，缺项报在字段上并定位、不发请求（F-164 第 1 轮 P2-4），后端仍复核；
 * 填齐后有改动先保存，再同意本人待办。保存与提交任一命令处理中 / 结果未知 / 冲突时整张表单锁定，
 * 计划上的其他动作（制定任务、干预）随计划恢复槽一并锁定，反之亦然。
 */
export function ReviewForm(props: ReviewProps) {
  const { plan } = props;
  const session = useSession();
  const names = useNames('employee', [session.employeeId]);
  const [form] = Form.useForm<ReviewValues>();
  const { command, baseline, save } = useReviewSave(props, form);
  const instanceId = props.stage.approvalInstanceId ?? undefined;
  const { approval, approve, ready } = useReviewApproval(instanceId, plan.revision, props.saved);
  const locked = command.locked || approval.locked || !!approval.blocked;
  const [notice, setNotice] = useState<string>();
  const validated = () => (locked ? Promise.resolve(undefined) : form.validateFields().catch(() => undefined));
  const onSave = async () => {
    const values = await validated();
    if (values) await save(values);
  };
  const onSubmit = async () => {
    setNotice(undefined);
    const values = await validated();
    if (!values) return;
    const missing = missingReview(values);
    if (missing.length) {
      form.setFields(missing.map((name) => ({ name, errors: [t.reviewForm.required(LABELS[name])] })));
      form.scrollToField(missing[0]!, { focus: true });
      return;
    }
    const changed = REVIEW_FIELDS.some((field) => (values[field] ?? null) !== baseline[field]);
    if (changed && !(await save(values))) return;
    setNotice(await approve());
  };
  return (
    <section aria-label={t.reviewForm.overall} className="idp-review-form">
      <Typography.Title level={5}>{t.reviewForm.overall}</Typography.Title>
      <Space className="idp-review-filler">
        <span>{names(session.employeeId)}</span>
        {plan.currentNodeName && <Tag color="blue">{display(plan.currentNodeName)}</Tag>}
      </Space>
      <CommandStatus submission={command} labels={LABELS} />
      <CommandStatus submission={approval} />
      {notice && <Typography.Text type="warning">{notice}</Typography.Text>}
      <FormLock locked={locked}>
        <ReviewFields form={form} baseline={baseline} />
      </FormLock>
      <div className="idp-review-actions">
        <Button loading={command.busy} disabled={locked} onClick={() => void onSave()}>
          {t.reviewForm.save}
        </Button>
        {ready && (
          <Button type="primary" loading={approval.busy} disabled={locked} onClick={() => void onSubmit()}>
            {t.reviewForm.submit}
          </Button>
        )}
      </div>
    </section>
  );
}

function ReviewFields(props: { form: FormInstance<ReviewValues>; baseline: ReviewValues }) {
  return (
    <Form form={props.form} layout="vertical" initialValues={props.baseline}>
      {REVIEW_FIELDS.map((field) => (
        <Form.Item
          key={field}
          name={field}
          label={LABELS[field]}
          // 星号照原站；保存是草稿不拦空，提交时才查必填（missingReview）
          required
          rules={[lengthRule(field)]}
        >
          <LockedField>
            <Input.TextArea
              rows={4}
              placeholder={t.reviewForm.hint}
              count={{ show: true, max: REVIEW_MAX, strategy: (value) => codepoints(value) }}
            />
          </LockedField>
        </Form.Item>
      ))}
    </Form>
  );
}

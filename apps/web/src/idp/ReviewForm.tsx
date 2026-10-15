import { Button, Form, Input, Space, Tag, Typography, type FormInstance } from 'antd';
import { useEffect, useState } from 'react';
import { acceptReceipt, approvalRequest, readApproval } from '../approval/api.js';
import { useApprovalCommand } from '../approval/commands.js';
import type { ApprovalDetail } from '../approval/types.js';
import { myPendingTask } from '../contracts/forms.js';
import { ApiError } from '../foundation/client.js';
import { forAction } from '../foundation/forms/action.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import { isLocked, slotContext } from '../foundation/forms/store.js';
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
  reviewStage,
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
 * 提交在发同意之前、保存在发 PUT 之前停下（保存未确认、计划上有未确认命令、阶段已变、没有本人待办、读取失败）：同意没有发出，
 * 按被拒收尾、不锁定（同 approvalRequest 的 ACTION_UNAVAILABLE），随后清掉命令、提示原因。
 */
const STOPPED = 'IDP_REVIEW_SUBMIT_STOPPED';
const stop = (message: string): never => {
  throw new ApiError(409, STOPPED, 'conflict', message);
};

/**
 * 计划各版本上运行中的阶段（阶段 + 审批实例），按租户 + 计划记。后端开启、结束阶段都推进计划 revision
 * （stage-service bumpPlan），版本定了阶段就定了；PUT 模块内容带 If-Match、按执行人当前阶段写，请求体不带阶段
 * （execution-service saveModuleContent）。所以发 PUT 前按请求版本核对命令的阶段，旧阶段的草稿就写不进新阶段
 * （F-164 第 3 轮 P2）。渲染与冲突重读读到的版本都记下；模块级保存，切换入口再回来仍在。
 */
const stagesAt = new Map<string, Map<number, string>>();
const STAGES_KEPT = 20;
type ReviewContext = { stageId: string; instanceId: string };
const contextOf = (stage: Pick<Stage, 'id' | 'approvalInstanceId'>): ReviewContext => ({
  stageId: stage.id,
  instanceId: stage.approvalInstanceId ?? '',
});
const keyOf = (context: ReviewContext) => `${context.stageId}|${context.instanceId}`;
function remember(scope: string, plan: PlanDetail) {
  if (typeof plan.revision !== 'number') return;
  const known = stagesAt.get(scope) ?? new Map<number, string>();
  stagesAt.set(scope, known);
  const running = plan.stages?.find((row) => row.status === 'running');
  known.set(plan.revision, running ? keyOf(contextOf(running)) : '');
  if (known.size > STAGES_KEPT) known.delete(Math.min(...known.keys()));
}
const stageAt = (scope: string, revision: number | undefined) =>
  revision === undefined ? undefined : stagesAt.get(scope)?.get(revision);
/** 已知最新版本上运行中的阶段。 */
function newestStage(scope: string) {
  const known = stagesAt.get(scope);
  return known?.size ? known.get(Math.max(...known.keys())) : undefined;
}

/**
 * 回顾保存：F-142 提交内核，回顾写的是计划（带计划 revision），命令放在计划的恢复槽，动作记“回顾 + 模块”，
 * 阶段作为命令上下文存进槽里（F-147）；冲突按计划详情重读后由内核回填。保存是草稿，两项可以先空着。
 */
function useReviewSave(props: ReviewProps, form: FormInstance<ReviewValues>) {
  const { plan, module, saved } = props;
  const api = useApiClient();
  const scope = `${useSession().tenantId}/${plan.id}`;
  remember(scope, plan);
  const command = forAction(useCommandForm(slotKey(`${IDP_API}/plans`, plan.id)), {
    action: 'review',
    moduleId: module.id,
  });
  // 未完成的命令沿用它当初的阶段；阶段已切换时按 moved 让旧上下文失效，发 PUT 前再按版本核对。
  const editing = slotContext<ReviewContext>(command.state) ?? contextOf(props.stage);
  const stageId = editing.stageId;
  const baseline = stageReview(plan, module.id, stageId);
  useDraftRefill(command, REVIEW_FIELDS, form);
  const path = `${IDP_API}/plans/${plan.id}/modules/${module.id}/content`;
  const reload = () =>
    command.reread(async (id) => {
      const row = await api.request<PlanDetail>(`${IDP_API}/plans/${id ?? plan.id}`);
      const receipt = rereadReceipt(row, plan.id);
      remember(scope, row);
      return { ...receipt, values: stageReview(row, module.id, stageId) };
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
      context: editing,
      // 回执是完整计划详情：同一计划且版本前进才算保存成功，否则按结果未知锁定（F-164 第 1 轮 P2-3）
      send: async (request) => {
        // 保存、提交都经这里：请求版本上的运行中阶段须是本命令的阶段与审批实例，否则不发（按被拒收尾）
        const sent = slotContext<ReviewContext>(command.peek());
        if (!sent || stageAt(scope, request.revision) !== keyOf(sent)) stop(t.reviewForm.stageChanged);
        const row = await api.request<PlanDetail>(path, { method: 'PUT', command: request });
        return saveReceipt(row, plan.id, request.revision);
      },
    });
    if (result.status === 'done') saved();
    return result.status === 'done';
  };
  /** 计划恢复槽上有未确认的命令（本表单或同计划的制定任务、干预）：读的是存储里的当前状态，不是渲染时的快照。 */
  const unsettled = () => isLocked(command.peek());
  /** 重读计划：仍在本阶段、本审批实例上才能同意。 */
  const sameStage = async (instanceId: string) => {
    const row = await api.request<PlanDetail>(`${IDP_API}/plans/${plan.id}`).catch(() => undefined);
    const current = row?.modules?.find((item) => item.id === module.id);
    const stage = row && current ? reviewStage(row, current) : undefined;
    return stage?.id === stageId && stage.approvalInstanceId === instanceId;
  };
  /**
   * 正在编辑的阶段已不是已知最新版本上的阶段（冲突重读或计划刷新发现阶段已变）：旧编辑上下文失效，
   * 草稿锁定只供参考，显式进入当前阶段后才能再写。处理中、结果未知、冲突未重读的命令仍按原规则锁定。
   */
  const state = command.state;
  const unread = state?.status === 'conflict' && (!state.latest || !!state.reading || !!state.readError);
  const newest = newestStage(scope);
  const moved = !['submitting', 'unknown'].includes(command.status) && !unread && newest !== keyOf(editing);
  /** 进入当前阶段：放下旧阶段的命令与草稿，表单换成当前阶段的内容，并刷新计划（阶段变了随之重建表单）。 */
  const enter = () => {
    command.confirm();
    command.clear();
    form.setFieldsValue(stageReview(plan, module.id, props.stage.id));
    saved();
  };
  return { command: { ...command, reload }, baseline, save, unsettled, sameStage, moved, enter };
}

/** 本人在该实例上可以“同意”的在办待办；不在回顾节点、不是处理人、已提交时没有。 */
const approvableTask = (detail: ApprovalDetail, userId: string | undefined) =>
  detail.actions.includes('approve') ? myPendingTask(detail, userId) : undefined;

/**
 * 回顾提交 = 同意本人在本阶段审批实例上的待办（POST /approval/tasks/:taskId/approve，If-Match 实例 revision）。
 * 命令放在流程实例的恢复槽（审批模块级存储，与审批详情、合同催办共用，F-147），动作与待办记在槽上下文；
 * 回执须是本实例且版本前进（acceptReceipt）。先读实例：本人没有可同意的待办就不给提交入口（`ready` 为假）。
 * 整个提交是这一条命令：点击即处于处理中，保存改动、重读、同意都在 send 里，期间表单与“保存”一直锁定，
 * 不会在保存成功到同意之间解锁（F-164 第 2 轮 P2）。版本取点击时读到的实例版本：回顾保存不改审批实例，
 * 期间实例若有变化由后端按 If-Match 判冲突。
 */
function useReviewApproval(instanceId: string | undefined, version: unknown, saved: () => void) {
  const api = useApiClient();
  const session = useSession();
  const approval = forAction(useApprovalCommand(slotKey(APPROVAL_INSTANCES, instanceId)), { action: 'approve' });
  const [pending, setPending] = useState<{ detail: ApprovalDetail; taskId: string }>();
  useEffect(() => {
    let live = true;
    const settle = (detail?: ApprovalDetail) => {
      const taskId = detail && approvableTask(detail, session.userId);
      if (live) setPending(detail && taskId ? { detail, taskId } : undefined);
    };
    if (!instanceId) settle();
    else readApproval(api, instanceId).then(settle, () => settle());
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
  /** prepare 在命令处理中执行（保存改动、核对阶段），recheck 在发同意前最后核对；不满足时调用 stop。 */
  const approve = async (prepare: () => Promise<void>, recheck: () => void): Promise<string | undefined> => {
    if (!pending) return t.reviewForm.noTask;
    if (approval.status === 'rejected' || approval.status === 'done') approval.clear();
    const result = await approval.submit({
      values: {},
      baseline: {},
      editableFields: [],
      revision: pending.detail.revision,
      businessId: pending.detail.id,
      context: { taskId: pending.taskId },
      send: async (sent) => {
        await prepare();
        const detail = await readApproval(api, pending.detail.id).catch(() => stop(t.reviewForm.readFailed));
        const taskId = approvableTask(detail, session.userId) ?? stop(t.reviewForm.noTask);
        recheck();
        const request = approvalRequest(detail, 'approve', taskId, sent.body);
        const receipt = await api.request<unknown>(request.path, {
          method: 'POST',
          command: { ...sent, body: request.body },
        });
        return acceptReceipt(receipt, detail.id, sent.revision ?? pending.detail.revision);
      },
    });
    const error = result.error;
    if (result.status === 'rejected' && error instanceof ApiError && error.code === STOPPED) {
      approval.clear();
      return error.message;
    }
    if (result.status !== 'done') return undefined;
    approval.clear();
    saved();
  };
  // 命令未确认（处理中、结果未知、冲突）时入口保留并锁定，不因待办状态变化而消失
  const ready = !!pending || approval.status !== 'idle';
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
  const { command, baseline, save, unsettled, sameStage, moved, enter } = useReviewSave(props, form);
  const instanceId = props.stage.approvalInstanceId ?? undefined;
  const { approval, approve, ready } = useReviewApproval(instanceId, plan.revision, props.saved);
  const locked = command.locked || approval.locked || !!approval.blocked || moved;
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
    const recheck = () => {
      if (unsettled()) stop(t.reviewForm.planPending);
    };
    const prepare = async () => {
      if (changed && !(await save(values))) stop(t.reviewForm.saveUnconfirmed);
      if (!(await sameStage(instanceId!))) stop(t.reviewForm.stageChanged);
      recheck();
    };
    setNotice(await approve(prepare, recheck));
  };
  return (
    <section aria-label={t.reviewForm.overall} className="idp-review-form">
      <Typography.Title level={5}>{t.reviewForm.overall}</Typography.Title>
      <Space className="idp-review-filler">
        <span>{names(session.employeeId)}</span>
        {plan.currentNodeName && <Tag color="blue">{display(plan.currentNodeName)}</Tag>}
      </Space>
      {moved ? (
        <Space className="idp-review-moved">
          <Typography.Text type="warning">{t.reviewForm.stageMoved}</Typography.Text>
          <Button size="small" onClick={enter}>
            {t.reviewForm.enterStage}
          </Button>
        </Space>
      ) : (
        <CommandStatus submission={command} labels={LABELS} />
      )}
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

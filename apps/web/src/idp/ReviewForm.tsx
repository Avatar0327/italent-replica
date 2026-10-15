import { Button, Form, Input, Space, Tag, Typography } from 'antd';
import { forAction } from '../foundation/forms/action.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import { slotContext } from '../foundation/forms/store.js';
import { useCommandForm, useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { rereadReceipt } from './access.js';
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

/** 与后端同口径按码点计长，超长前端拦下不发请求。 */
const lengthRule = (field: keyof ReviewValues) => ({
  validator: (_: unknown, value: string | null | undefined) =>
    reviewTooLong({ [field]: value }).length
      ? Promise.reject(new Error(t.reviewForm.tooLong(REVIEW_MAX)))
      : Promise.resolve(),
});

/**
 * 当前阶段的回顾填写（原站 B4_26“总体回顾”；F-155b）：总结、改进方法两个多行框，各 ≤1000 字，右下角计数。
 * 保存走 F-142 提交内核：回顾写的是计划（带计划 revision），命令放在计划的恢复槽，动作记“回顾 + 模块”，
 * 阶段作为命令上下文存进槽里（F-147）；处理中 / 结果未知 / 冲突时锁住，计划上的其他动作（制定任务、干预）
 * 一并锁定，反之亦然；冲突按计划详情重读后由内核回填。保存是草稿，两项可以先空着；提交审批时缺项由后端 409 IDP_REVIEW_REQUIRED 拦下。
 */
export function ReviewForm(props: { plan: PlanDetail; module: PlanModule; stage: Stage; saved(): void }) {
  const { plan, module, saved } = props;
  const api = useApiClient();
  const session = useSession();
  const names = useNames('employee', [session.employeeId]);
  const command = forAction(useCommandForm(slotKey(`${IDP_API}/plans`, plan.id)), {
    action: 'review',
    moduleId: module.id,
  });
  // 未完成的命令沿用它当初的阶段；阶段已切换时提交仍按原阶段核对（后端按当前阶段复核，变了会拒绝）。
  const stageId = slotContext<{ stageId: string }>(command.state)?.stageId ?? props.stage.id!;
  const baseline = stageReview(plan, module.id, stageId);
  const [form] = Form.useForm<ReviewValues>();
  useDraftRefill(command, REVIEW_FIELDS, form);
  const path = `${IDP_API}/plans/${plan.id}/modules/${module.id}/content`;
  const reload = () =>
    command.reread(async (id) => {
      const row = await api.request<PlanDetail>(`${IDP_API}/plans/${id ?? plan.id}`);
      return { ...rereadReceipt(row, plan.id), values: stageReview(row, module.id, stageId) };
    });
  const save = async () => {
    if (command.locked) return;
    const values = await form.validateFields().catch(() => undefined);
    if (!values) return;
    if (command.status === 'rejected' || command.status === 'done') command.clear();
    const result = await command.submit({
      values: { ...baseline, ...values },
      baseline,
      editableFields: REVIEW_FIELDS,
      revision: plan.revision!,
      businessId: plan.id,
      patchOnly: true,
      context: { stageId },
      send: async (request) => {
        const response = await api.request<PlanDetail>(path, { method: 'PUT', command: request });
        return { id: typeof response?.id === 'string' ? response.id : '' };
      },
    });
    if (result.status === 'done') saved();
  };
  return (
    <section aria-label={t.reviewForm.overall} className="idp-review-form">
      <Typography.Title level={5}>{t.reviewForm.overall}</Typography.Title>
      <Space className="idp-review-filler">
        <span>{names(session.employeeId)}</span>
        {plan.currentNodeName && <Tag color="blue">{display(plan.currentNodeName)}</Tag>}
      </Space>
      <CommandStatus submission={{ ...command, reload }} labels={LABELS} />
      <FormLock locked={command.locked}>
        <Form form={form} layout="vertical" initialValues={baseline}>
          {REVIEW_FIELDS.map((field) => (
            <Form.Item
              key={field}
              name={field}
              label={LABELS[field]}
              // 星号照原站；保存是草稿不拦空，必填在提交审批时由后端校验
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
      </FormLock>
      <div className="idp-review-actions">
        <Button type="primary" loading={command.busy} disabled={command.locked} onClick={() => void save()}>
          {t.reviewForm.save}
        </Button>
      </div>
    </section>
  );
}

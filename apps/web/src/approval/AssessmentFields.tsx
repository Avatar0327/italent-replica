import {
  ASSESSMENT_OPINIONS,
  ASSESSMENT_RATINGS,
  OPINIONS_REQUIRING_DATE,
  type AssessmentOpinion,
} from '@italent/domain';
import { Form, Input, type FormItemProps } from 'antd';
import { useEffect } from 'react';
import type { FormField } from '../foundation/FormOverlay.js';

/** F-297：试用中考核 / 转正考核的审批编辑（assessment-approval-adapter.ts，经理评价节点可编辑三项）。 */
export const assessmentApprovalTypes = ['probation_assessment', 'regularization_assessment'];
export const assessmentLabels: Record<string, string> = {
  assessmentName: '考核名称',
  assessmentDate: '考核日期',
  selfEvaluation: '员工自评',
  managerRating: '经理评价',
  regularizationOpinion: '转正意见',
  regularizationDate: '转正日期',
};
// 同后端 assessmentOpinionViolation（ASSESSMENT_DATE_REQUIRED）原文
export const dateRequiredMessage = '提前转正 / 延期转正须填写转正日期';
const requiredMessage = '请填写必填字段';

/** 提前 / 延期转正要求转正日期（OPINIONS_REQUIRING_DATE）；意见清空或其他意见不要求。 */
export const opinionNeedsDate = (opinion: unknown) => OPINIONS_REQUIRING_DATE.includes(opinion as AssessmentOpinion);

/** 转正日期的联动必填：意见本身不在本节点可编辑时取详情当前值。 */
export function dateRule(opinion: unknown): NonNullable<FormItemProps['rules']>[number] {
  return ({ getFieldValue }) => ({
    validator: async (_, value: unknown) => {
      const current =
        getFieldValue('regularizationOpinion') === undefined ? opinion : getFieldValue('regularizationOpinion');
      if (opinionNeedsDate(current) && (value === null || value === undefined || value === ''))
        throw new Error(dateRequiredMessage);
    },
  });
}

/**
 * 只映射考核表单里已实现的控件；节点可编辑哪些字段、哪些必填仍以详情 edit.fields 为准（required 来自服务端）。
 * 考核日期、考核名称在审批节点不可编辑（后端 editableFields 不含），出现时也只读。
 */
export function assessmentField(
  key: string,
  required: boolean,
  values: Record<string, unknown>,
): Pick<FormField, 'label' | 'control' | 'rules'> | undefined {
  const label = assessmentLabels[key] ?? key;
  const rules: NonNullable<FormItemProps['rules']> = required ? [{ required: true, message: requiredMessage }] : [];
  if (key === 'selfEvaluation') return { label, rules, control: <TextControl label={label} /> };
  if (key === 'managerRating')
    return { label, rules, control: <ChoiceControl label={label} options={ratingOptions} /> };
  if (key === 'regularizationOpinion')
    return { label, rules, control: <ChoiceControl label={label} options={opinionOptions} /> };
  if (key === 'regularizationDate')
    return {
      label,
      rules: [...rules, dateRule(values.regularizationOpinion)],
      control: <DateControl label={label} opinion={values.regularizationOpinion} />,
    };
  return undefined;
}

const opinionOptions = Object.entries(ASSESSMENT_OPINIONS);
const ratingOptions = Object.entries(ASSESSMENT_RATINGS);
type ControlProps = { label: string; id?: string; value?: string | null; onChange?(value: string | null): void };
function ChoiceControl({ label, options, value, onChange, ...props }: ControlProps & { options: string[][] }) {
  return (
    <select
      {...props}
      className="ant-input"
      aria-label={label}
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value || null)}
    >
      <option value="">请选择</option>
      {options.map(([code, name]) => (
        <option key={code} value={code}>
          {name}
        </option>
      ))}
    </select>
  );
}
function TextControl({ label, value, onChange, ...props }: ControlProps) {
  return (
    <Input.TextArea
      {...props}
      aria-label={label}
      rows={3}
      maxLength={2000}
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value || null)}
    />
  );
}

/**
 * 转正日期随转正意见联动：选中提前 / 延期转正时标出必填并提示，已填过的立即重验；清空意见或改为其他意见时取消必填、清掉错误。
 */
function DateControl({ label, opinion, value, onChange, ...props }: ControlProps & { opinion: unknown }) {
  const form = Form.useFormInstance();
  const watched: unknown = Form.useWatch('regularizationOpinion', form);
  const current = watched === undefined ? opinion : watched;
  const needed = opinionNeedsDate(current);
  useEffect(() => {
    if (!form.isFieldTouched('regularizationDate') && !form.getFieldError('regularizationDate').length) return;
    if (needed) void form.validateFields(['regularizationDate']).catch(() => undefined);
    else form.setFields([{ name: 'regularizationDate', errors: [] }]);
  }, [form, needed]);
  return (
    <>
      <Input
        {...props}
        type="date"
        aria-label={label}
        aria-required={needed}
        value={value ?? ''}
        onChange={(event) => onChange?.(event.target.value || null)}
      />
      {needed && (
        <div className="ant-form-item-extra" role="note">
          <span className="assessment-required">*</span> {dateRequiredMessage}
        </div>
      )}
    </>
  );
}

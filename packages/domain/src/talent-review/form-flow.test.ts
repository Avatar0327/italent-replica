import { describe, expect, it } from 'vitest';
import { TALENT_REVIEW_PRESET_FIELDS } from './fields.js';
import { checkFlowNodes, checkFormFields, presetFormAccess, TALENT_REVIEW_PRESET_FORMS } from './form-flow.js';

describe('表单字段三档（DEC-306①）', () => {
  it('同一字段不能在表单里出现两次', () => {
    const rows = [
      { fieldId: 'a', access: 'edit', required: false },
      { fieldId: 'a', access: 'view', required: false },
    ] as const;
    expect(checkFormFields(rows)?.reason).toBe('FORM_FIELD_DUPLICATE');
  });

  it('必填只能设在可编辑的字段上', () => {
    expect(checkFormFields([{ fieldId: 'a', access: 'view', required: true }])?.reason).toBe(
      'FORM_REQUIRED_NEEDS_EDIT',
    );
    expect(checkFormFields([{ fieldId: 'a', access: 'hidden', required: true }])?.reason).toBe(
      'FORM_REQUIRED_NEEDS_EDIT',
    );
    expect(checkFormFields([{ fieldId: 'a', access: 'edit', required: true }])).toBeNull();
  });
});

describe('流程节点约束（设计 §2.2 flows / nodes）', () => {
  const node = (extra: Partial<Parameters<typeof checkFlowNodes>[0][number]> = {}) => ({
    nodeKey: 'n1',
    kind: 'single' as const,
    stepType: 'evaluate' as const,
    mode: 'single' as const,
    roleCount: 1,
    ...extra,
  });

  it('countersign 只能是 evaluate + single，且至少一个角色', () => {
    expect(checkFlowNodes([node({ kind: 'countersign', roleCount: 3 })])).toBeNull();
    expect(checkFlowNodes([node({ kind: 'countersign', stepType: 'calibrate' })])?.reason).toBe(
      'FLOW_COUNTERSIGN_INVALID',
    );
    expect(checkFlowNodes([node({ kind: 'countersign', mode: 'batch' })])?.reason).toBe('FLOW_COUNTERSIGN_INVALID');
    expect(checkFlowNodes([node({ kind: 'countersign', roleCount: 0 })])?.reason).toBe('FLOW_ROLE_COUNT_INVALID');
  });

  it('single 节点恰一个角色', () => {
    expect(checkFlowNodes([node({ roleCount: 0 })])?.reason).toBe('FLOW_ROLE_COUNT_INVALID');
    expect(checkFlowNodes([node({ roleCount: 2 })])?.reason).toBe('FLOW_ROLE_COUNT_INVALID');
  });

  it('node_key 流程内唯一', () => {
    expect(checkFlowNodes([node(), node()])?.reason).toBe('FLOW_NODE_KEY_DUPLICATE');
    expect(checkFlowNodes([node(), node({ nodeKey: 'n2' })])).toBeNull();
  });
});

describe('预置四个表单字段集合（设计 §2.7）', () => {
  const accessOf = (form: string) =>
    Object.fromEntries(TALENT_REVIEW_PRESET_FIELDS.map((field) => [field.code, presetFormAccess(form, field)]));
  const editable = (form: string) =>
    Object.entries(accessOf(form))
      .filter(([, access]) => access === 'edit')
      .map(([code]) => code);

  it('四个表单的编码、名称、类型', () => {
    expect(TALENT_REVIEW_PRESET_FORMS.map((form) => [form.name, form.kind])).toEqual([
      ['员工自评盘点信息表单', 'info'],
      ['上级评价盘点信息表单', 'info'],
      ['管理员查看盘点信息表单', 'info'],
      ['批量盘点可编辑信息', 'calibrate_edit'],
    ]);
  });

  it('员工自评 = 评价分组可编辑，其余隐藏', () => {
    const access = accessOf('self_info');
    expect(editable('self_info')).toEqual([
      'strengths',
      'development_areas',
      'development_advice',
      'contribution_3y',
      'development_direction',
      'mobility_willingness',
    ]);
    expect(Object.values(access).filter((value) => value === 'view')).toHaveLength(0);
  });

  it('上级评价 = 结果分组校准前字段、标签、评价分组可编辑', () => {
    expect(editable('supervisor_info')).toEqual([
      'achievement_before',
      'capability_before',
      'appraisal_before',
      'potential_before',
      'tags',
      'strengths',
      'development_areas',
      'development_advice',
      'contribution_3y',
      'development_direction',
      'mobility_willingness',
    ]);
  });

  it('管理员查看 = 全部预置字段只读', () => {
    expect(Object.values(accessOf('admin_view')).every((value) => value === 'view')).toBe(true);
  });

  it('批量盘点可编辑 = 结果分组校准后字段、标签、校准分组可编辑', () => {
    expect(editable('batch_calibrate')).toEqual([
      'achievement_after',
      'capability_after',
      'appraisal_after',
      'potential_after',
      'tags',
      'calibration_reason',
      'remark',
    ]);
  });
});

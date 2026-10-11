/**
 * 盘点内容表单与流程定义的领域常量、保存校验（纯函数）与预置表单清单（R3-T04 设计 §2.2 forms / flows、§2.7；DEC-306①）。
 * 表单 = 一组盘点字段逐字段三档（edit / view / hidden）+ required；流程 = 有序节点，节点带角色。
 */
import type { PresetField } from './fields.js';
import { TALENT_REVIEW_PRESET_FIELDS } from './fields.js';

export const FORM_KINDS = ['info', 'calibrate_edit', 'succession_edit'] as const;
export type FormKind = (typeof FORM_KINDS)[number];
export const FORM_ACCESS = ['edit', 'view', 'hidden'] as const;
export type FormAccess = (typeof FORM_ACCESS)[number];

export const FLOW_NODE_KINDS = ['single', 'countersign'] as const;
export type FlowNodeKind = (typeof FLOW_NODE_KINDS)[number];
export const FLOW_STEP_TYPES = ['evaluate', 'calibrate'] as const;
export type FlowStepType = (typeof FLOW_STEP_TYPES)[number];
export const FLOW_NODE_MODES = ['single', 'batch'] as const;
export type FlowNodeMode = (typeof FLOW_NODE_MODES)[number];
/** node_key 的格式：模板版本按它冻结节点副本，保存后不可改。 */
export const FLOW_NODE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const FLOW_MAX_NODES = 20;
export const FLOW_MAX_NODE_ROLES = 20;

/** 校验不通过：reason 是机器可读的原因码，message 是给人看的说明。 */
export interface FormFlowViolation {
  readonly reason: string;
  readonly message: string;
}
const violation = (reason: string, message: string): FormFlowViolation => ({ reason, message });

export interface FormFieldInput {
  readonly fieldId: string;
  readonly access: FormAccess;
  readonly required: boolean;
}

/** 字段在表单里至多出现一次；必填只对可编辑字段有意义（view / hidden 的字段谁也填不了）。 */
export function checkFormFields(fields: readonly FormFieldInput[]): FormFlowViolation | null {
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.fieldId)) return violation('FORM_FIELD_DUPLICATE', '同一个字段在表单里只能出现一次');
    seen.add(field.fieldId);
    if (field.required && field.access !== 'edit') {
      return violation('FORM_REQUIRED_NEEDS_EDIT', '只有可编辑的字段可以设为必填');
    }
  }
  return null;
}

export interface FlowNodeInput {
  readonly nodeKey: string;
  readonly kind: FlowNodeKind;
  readonly stepType: FlowStepType;
  readonly mode: FlowNodeMode;
  readonly roleCount: number;
}

/**
 * 节点约束（设计 §2.2）：node_key 流程内唯一；countersign 只能 evaluate + single；single 节点恰一个角色，
 * countersign 至少一个。
 */
export function checkFlowNodes(nodes: readonly FlowNodeInput[]): FormFlowViolation | null {
  const keys = new Set<string>();
  for (const node of nodes) {
    if (keys.has(node.nodeKey)) return violation('FLOW_NODE_KEY_DUPLICATE', `节点标识 ${node.nodeKey} 重复`);
    keys.add(node.nodeKey);
    if (node.kind === 'countersign' && (node.stepType !== 'evaluate' || node.mode !== 'single')) {
      return violation('FLOW_COUNTERSIGN_INVALID', '会签节点只能是评价步骤且单个提交');
    }
    const roleOk = node.kind === 'single' ? node.roleCount === 1 : node.roleCount >= 1;
    if (!roleOk) {
      const need = node.kind === 'single' ? '恰好一个' : '至少一个';
      return violation('FLOW_ROLE_COUNT_INVALID', `节点 ${node.nodeKey} 须有${need}角色`);
    }
  }
  return null;
}

export interface PresetForm {
  readonly code: string;
  readonly name: string;
  readonly kind: FormKind;
}
/** 预置四个盘点内容表单（设计 §2.7；字段集合 🟡 手册只列表单名，种子数据，取证可后补）。 */
export const TALENT_REVIEW_PRESET_FORMS: readonly PresetForm[] = [
  { code: 'self_info', name: '员工自评盘点信息表单', kind: 'info' },
  { code: 'supervisor_info', name: '上级评价盘点信息表单', kind: 'info' },
  { code: 'admin_view', name: '管理员查看盘点信息表单', kind: 'info' },
  { code: 'batch_calibrate', name: '批量盘点可编辑信息', kind: 'calibrate_edit' },
];

const isTags = (field: PresetField) => field.code === 'tags';
const editRule: Readonly<Record<string, (field: PresetField) => boolean>> = {
  self_info: (field) => field.group === 'evaluation',
  supervisor_info: (field) =>
    (field.group === 'result' && field.pairRole === 'before') || isTags(field) || field.group === 'evaluation',
  batch_calibrate: (field) =>
    (field.group === 'result' && field.pairRole === 'after') || isTags(field) || field.group === 'calibration',
};

/** 预置表单里某个预置字段的权限档位：管理员查看表单全部只读，其余按规则可编辑、未列出的隐藏。 */
export function presetFormAccess(formCode: string, field: PresetField): FormAccess {
  if (formCode === 'admin_view') return 'view';
  return editRule[formCode]?.(field) ? 'edit' : 'hidden';
}

/** 预置表单的字段行（按预置字段清单的顺序，覆盖全部预置字段）。 */
export const presetFormFields = (formCode: string) =>
  TALENT_REVIEW_PRESET_FIELDS.map((field) => ({ code: field.code, access: presetFormAccess(formCode, field) }));

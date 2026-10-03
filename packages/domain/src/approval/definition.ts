/**
 * 流程定义校验：保存草稿时做结构校验；发布时再做 DEC-018 / DEC-054 规则校验（REQ-APV-001 R4/R5、REQ-APV-002 R6）。
 */
import { conditionViolations } from './conditions.js';
import type { ApprovalTypeDefinition, ProcessDefinition } from './types.js';

export const MAX_NODES = 50;
const NODE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const CUSTOM_FIELD = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DefinitionViolation {
  readonly reason: string;
  readonly message: string;
}

export function definitionViolations(definition: ProcessDefinition, type: ApprovalTypeDefinition): string[] {
  const violations = conditionViolations(definition.conditions, type.conditionFields);
  if (!definition.name.trim()) violations.push('流程名称不能为空');
  if (definition.nodes.length > MAX_NODES) violations.push(`节点最多 ${MAX_NODES} 个`);
  const keys = new Set<string>();
  const formFields = new Set(type.formFields);
  for (const node of definition.nodes) {
    if (!NODE_KEY.test(node.key) || keys.has(node.key)) violations.push(`节点编码 ${node.key} 不合法或重复`);
    keys.add(node.key);
    if (!node.name.trim()) violations.push(`节点 ${node.key} 名称不能为空`);
    // 任职类审批的节点表单可配置租户自定义任职字段（权限编码 custom:<id>，清单 3）。
    const known = (field: string) =>
      formFields.has(field) || (type.adapter === 'employment' && CUSTOM_FIELD.test(field));
    const unknown = node.formFields.filter((field) => !known(field));
    if (unknown.length) violations.push(`节点 ${node.key} 表单字段不在对象目录内：${unknown.join('、')}`);
    const notOnForm = node.editableFields.filter((field) => !node.formFields.includes(field));
    if (notOnForm.length) violations.push(`节点 ${node.key} 可编辑字段必须在节点表单上：${notOnForm.join('、')}`);
    const readonly = node.editableFields.filter((field) => type.readonlyFields.includes(field));
    if (readonly.length) violations.push(`节点 ${node.key} 的只读带出字段不能编辑：${readonly.join('、')}`);
    if ((node.editMode === 'none') !== (node.editableFields.length === 0)) {
      violations.push(`节点 ${node.key} 的审批中编辑形态与可编辑字段不一致`);
    }
    if (!type.approvalEdit && node.editMode !== 'none') {
      violations.push(`节点 ${node.key}：${type.name}审批不支持审批中编辑（DEC-105）`);
    }
  }
  return violations;
}

/** 发布校验：发起条件为空须显式兜底（DEC-018）；异常管理员必填（DEC-054）；至少一个审批节点。 */
export function publishViolations(definition: ProcessDefinition): DefinitionViolation[] {
  const violations: DefinitionViolation[] = [];
  if (!definition.conditions.items.length && !definition.isFallback) {
    violations.push({
      reason: 'APPROVAL_CONDITION_REQUIRED',
      message: '发起条件为空的流程只能在声明为本业务类型兜底流程时发布，请补充发起条件',
    });
  }
  if (!definition.exceptionAdminUserId) {
    violations.push({ reason: 'APPROVAL_EXCEPTION_ADMIN_REQUIRED', message: '流程必须配置异常管理员才能发布' });
  }
  if (!definition.nodes.length)
    violations.push({ reason: 'APPROVAL_NODES_REQUIRED', message: '流程至少需要一个审批节点' });
  return violations;
}

/**
 * 盘点内容表单与流程定义的请求结构（只做结构校验，不读库）。严格对象：未登记的键一律 400；表单编码建后不可改，修改不收它。
 * 表单字段整组提交（字段三档 + required）；流程节点整组提交，已有节点带稳定 id（node_key 不可改由保存命令按 id 判定）。
 */
import {
  FLOW_MAX_NODE_ROLES,
  FLOW_MAX_NODES,
  FLOW_NODE_KEY_PATTERN,
  FLOW_NODE_KINDS,
  FLOW_NODE_MODES,
  FLOW_STEP_TYPES,
  FORM_ACCESS,
  FORM_KINDS,
} from '@italent/domain';
import { z } from 'zod';

/** 标识统一小写规范化（DEC-194）。 */
const uuid = z.uuid().transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(50);
const sortNo = z.int().min(0).max(1_000_000);

const formField = z.strictObject({
  fieldId: uuid,
  access: z.enum(FORM_ACCESS),
  required: z.boolean().default(false),
});
export const formCreate = z.strictObject({
  code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,49}$/, '编码须以字母开头，仅含字母、数字、下划线'),
  name,
  kind: z.enum(FORM_KINDS),
  sortNo: sortNo.optional(),
  enabled: z.boolean().optional(),
  fields: z.array(formField).max(200),
});
export const formPatch = formCreate.omit({ code: true }).partial();

const node = z.strictObject({
  id: uuid.optional(),
  nodeKey: z.string().regex(FLOW_NODE_KEY_PATTERN, '节点标识须以小写字母开头，仅含小写字母、数字、下划线'),
  name,
  kind: z.enum(FLOW_NODE_KINDS),
  stepType: z.enum(FLOW_STEP_TYPES),
  mode: z.enum(FLOW_NODE_MODES),
  allowReturn: z.boolean().default(false),
  allowTransfer: z.boolean().default(false),
  allowDisagree: z.boolean().default(false),
  roleIds: z.array(uuid).max(FLOW_MAX_NODE_ROLES),
});
export const flowCreate = z.strictObject({
  name,
  sortNo: sortNo.optional(),
  enabled: z.boolean().optional(),
  nodes: z.array(node).min(1).max(FLOW_MAX_NODES),
});
export const flowPatch = flowCreate.partial();

export type FormCreate = z.output<typeof formCreate>;
export type FormPatch = z.output<typeof formPatch>;
export type FlowCreate = z.output<typeof flowCreate>;
export type FlowPatch = z.output<typeof flowPatch>;
export type FlowNodeBody = z.output<typeof node>;

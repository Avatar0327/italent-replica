/**
 * F-481 电子签配置页的纯规则（后端 apps/api/src/modules/esign/routes.ts、input.ts）。
 * 不依赖 React 或浏览器 API；权威校验在服务端，这里只做提交前的同口径提示。
 */
import { isValidValidityDays, unknownTemplateVariables } from '@italent/domain';
import { configAccess } from '../contracts/model.js';
import type { ObjectPermission } from '../foundation/permission-model.js';
import { m } from './messages.js';

export const ESIGN_SETTINGS_OBJECT = 'TenantBase.ESignSettings';
export const ESIGN_BASE = '/api/tenant/esign';
export const TEMPLATES_PATH = `${ESIGN_BASE}/templates`;
export const SCENE_PATH = `${ESIGN_BASE}/scenes/transfer`;
// 模板下拉按入口分两个接口（esign/routes.ts、task-routes.ts），授权分别同发起调动与补发。
export const TRANSFER_FORM_OPTIONS_PATH = `${ESIGN_BASE}/template-options/transfer-form`;
export const REISSUE_OPTIONS_PATH = `${ESIGN_BASE}/template-options/reissue`;
export const TRANSFER_TASKS_PATH = `${ESIGN_BASE}/transfer-tasks`;
export const templatePath = (id: string) => `${TEMPLATES_PATH}/${encodeURIComponent(id)}`;
export const NAME_MAX = 100;
export const CODE_MAX = 100;
export const BODY_MAX = 20000;
const SORT_LIMIT = 1_000_000;
/** 编辑表单字段；编码创建后不可改（DEC-060），状态只经行内启用 / 停用改。 */
export const templateFields = ['name', 'body', 'sortOrder'] as const;

// 字段可能被查看权裁掉，只有 id / 版本必有（routes.ts trim）。
export type TemplateRow = {
  id: string;
  revision: number;
  code?: string;
  name?: string;
  body?: string;
  status?: 'enabled' | 'disabled';
  sortOrder?: number;
};
export type SceneRow = { revision: number; validityDays?: number; remindBeforeExpiry?: boolean };

const isRevision = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const isRow = (raw: unknown): raw is TemplateRow => {
  const row = raw as Partial<TemplateRow> | null;
  return !!row && typeof row.id === 'string' && row.id !== '' && isRevision(row.revision);
};
export function parseTemplates(raw: unknown): TemplateRow[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || !items.every(isRow)) throw new Error(m.invalidList);
  return items;
}
export function parseScene(raw: unknown): SceneRow {
  const scene = raw as Partial<SceneRow> & { scene?: unknown };
  if (!scene || scene.scene !== 'transfer' || !isRevision(scene.revision)) throw new Error(m.invalidList);
  return scene as SceneRow;
}
/** 写回执：同一对象、版本 = 实际提交的版本 + 1（新建不核对 id，版本从 1 起）。 */
export function parseTemplateReceipt(raw: unknown, expected: { id?: string; revision: number }) {
  if (!isRow(raw) || (expected.id && raw.id !== expected.id) || raw.revision !== expected.revision + 1)
    throw new Error(m.invalidReceipt);
  return { id: raw.id };
}
export function parseSceneReceipt(raw: unknown, revision: number) {
  if (parseScene(raw).revision !== revision + 1) throw new Error(m.invalidReceipt);
  return { id: 'transfer' };
}

/** 文本框里的整数（空串视为未填）；非整数原样返回，交给校验提示。 */
export const integerOf = (value: unknown) =>
  typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : value;
export const validSortOrder = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Number.isSafeInteger(integerOf(value)) && Math.abs(integerOf(value) as number) <= SORT_LIMIT);
/** 正文里表外的变量名（与后端 assertKnownVariables 同一函数）。 */
export const unknownVariables = (body: unknown) => (typeof body === 'string' ? unknownTemplateVariables(body) : []);
export const validValidityDays = (value: unknown) => isValidValidityDays(integerOf(value));

/**
 * 电子签设置是配置类对象：写入口按数据操作 + 逐字段编辑权，不看按钮（同 contracts configAccess）——
 * /me/objects 对配置对象恒返回空按钮（permission/me.ts configObjectPermission），esign/routes.ts 写入也只校验
 * objectContext 的数据操作与 writeFields 的字段权。摘要未载入明细时不授予。
 */
export function settingsActions(permission: ObjectPermission | undefined) {
  const loaded = permission && !permission.summary ? permission : undefined;
  const { create, update } = configAccess(loaded);
  const editable = (field: string) => !!loaded?.viewableFields.includes(field) && loaded.editableFields.includes(field);
  return {
    create: create && ['code', 'name', 'body'].every(editable),
    edit: update && templateFields.some(editable),
    status: update && editable('status'),
    scene: update && editable('validityDays') && editable('remindBeforeExpiry'),
    editable,
  };
}

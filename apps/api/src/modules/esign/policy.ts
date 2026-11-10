/**
 * 调动电子签署配置路由的 F-039 声明（F-481 S1；设计 §10）。配置对象 TenantBase.ESignSettings：只有数据操作开关，没有按钮与
 * 数据范围（authorizer CONFIG_OBJECTS 分支）。模板下拉与“发起调动”同一授权（任职对象新增 + Transfer.Hr 按钮），不要求模板维护权。
 * 本文件新起的登记名：形状 esign.template / esign.scene，前提 esign.lock / esign.revision / esign.unique。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { defineTable } from '../../route-policy/index.js';
import {
  BAD_REQUEST,
  button,
  fixed,
  noButton,
  none,
  noScope,
  object,
  shape,
  write,
} from '../../route-policy/presets.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { ESIGN_BASE } from './routes.js';

const SETTINGS = MODULE_OBJECTS.eSignSettings.code;
const NO_BUTTON = noButton('配置对象只有数据操作开关，没有按钮（authorizer CONFIG_OBJECTS 分支）');
const NO_SCOPE = noScope('配置对象是租户全局配置，不参与数据范围判定');
const byId = { invalidId: BAD_REQUEST };
const configWrite = (action: string, preconditions: readonly string[]) =>
  write('body', `config.audited:${action}`, none('配置对象无范围，返回后只按配置对象字段权 trim'), { preconditions });

export const ESIGN_POLICIES = defineTable('esign', {
  [`GET ${ESIGN_BASE}/templates`]: object({
    object: SETTINGS,
    operation: 'view',
    button: NO_BUTTON,
    scope: NO_SCOPE,
    fields: shape('esign.template'),
  }),
  // 咨询锁 → 编码 / 名称唯一 → 插入 → 审计 esign.template.create；正文变量在命令前检查
  [`POST ${ESIGN_BASE}/templates`]: object({
    object: SETTINGS,
    operation: 'create',
    button: NO_BUTTON,
    scope: NO_SCOPE,
    fields: shape('esign.template'),
    write: configWrite('esign.template.create', ['esign.lock', 'esign.unique']),
  }),
  // If-Match 必填；咨询锁 → revision 比对（陈旧 409）→ 名称唯一 → 更新 → 审计 esign.template.update
  [`PATCH ${ESIGN_BASE}/templates/:id`]: object({
    object: SETTINGS,
    operation: 'update',
    button: NO_BUTTON,
    scope: NO_SCOPE,
    fields: shape('esign.template'),
    write: configWrite('esign.template.update', ['esign.lock', 'esign.revision', 'esign.unique']),
    ...byId,
  }),
  [`GET ${ESIGN_BASE}/scenes/transfer`]: object({
    object: SETTINGS,
    operation: 'view',
    button: NO_BUTTON,
    scope: NO_SCOPE,
    fields: shape('esign.scene'),
  }),
  // If-Match: 0 建第一版；咨询锁 → revision 比对 → upsert → 审计 esign.scene.update
  [`PUT ${ESIGN_BASE}/scenes/transfer`]: object({
    object: SETTINGS,
    operation: 'update',
    button: NO_BUTTON,
    scope: NO_SCOPE,
    fields: shape('esign.scene'),
    write: configWrite('esign.scene.update', ['esign.lock', 'esign.revision']),
  }),
  // 与 POST /transfers/employees/:id 的 HR 入口同一授权；固定键 id / name，只含启用模板
  [`GET ${ESIGN_BASE}/template-options/transfer-form`]: object({
    object: EMPLOYMENT_OBJECT,
    operation: 'create',
    button: button('Transfer.Hr', 'detail'),
    scope: NO_SCOPE,
    fields: fixed(['items'], 'service.ts templateOptions：items 仅含启用模板的 id 与 name，不含正文与编码'),
  }),
});

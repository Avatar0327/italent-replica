/**
 * 调动电子签署配置路由的 F-039 声明（F-481 S1；设计 §10）。配置对象 TenantBase.ESignSettings：只有数据操作开关，没有按钮与
 * 数据范围（authorizer CONFIG_OBJECTS 分支）。模板下拉与“发起调动”同一授权（任职对象新增 + Transfer.Hr 按钮），不要求模板维护权。
 * 本文件新起的登记名：形状 esign.template / esign.scene，前提 esign.lock / esign.revision / esign.unique。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { defineTable } from '../../route-policy/index.js';
import {
  BAD_REQUEST,
  NOT_FOUND,
  own,
  pointScope,
  commandWrite,
  button,
  fixed,
  noButton,
  none,
  noScope,
  object,
  shape,
  write,
  listScope,
  guardScope,
  allFields,
} from '../../route-policy/presets.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { ESIGN_BASE } from './routes.js';
import { REISSUE_BUTTON } from './reissue.js';

const SETTINGS = MODULE_OBJECTS.eSignSettings.code;
const RECORD = MODULE_OBJECTS.eSignRecord.code;
const recordButton = (code: string) =>
  object({
    object: RECORD,
    operation: 'button',
    button: button(code, 'list'),
    scope: guardScope('esign.recordOwner', NOT_FOUND),
    fields: fixed(['items'], 'F-481 §4.3：逐条 id/ok/code 回执，当前范围外统一 NOT_FOUND'),
    write: commandWrite('esign.task.audited', 'esign.recordOwner', { preconditions: ['esign.lock', 'esign.revision'] }),
  });
const NO_BUTTON = noButton('配置对象只有数据操作开关，没有按钮（authorizer CONFIG_OBJECTS 分支）');
const NO_SCOPE = noScope('配置对象是租户全局配置，不参与数据范围判定');
const byId = { invalidId: BAD_REQUEST };
const configWrite = (action: string, preconditions: readonly string[]) =>
  write('body', `config.audited:${action}`, none('配置对象无范围，返回后只按配置对象字段权 trim'), { preconditions });

export const ESIGN_POLICIES = defineTable('esign', {
  [`GET ${ESIGN_BASE}/records`]: object({
    object: RECORD,
    operation: 'view',
    button: noButton('列表只需对象查看权'),
    scope: listScope('esign.recordOwner'),
    fields: shape('esign.record'),
  }),
  [`POST ${ESIGN_BASE}/records/remind`]: recordButton('ESignRecord.Remind'),
  [`POST ${ESIGN_BASE}/records/revoke`]: recordButton('ESignRecord.Revoke'),
  [`GET ${ESIGN_BASE}/records/files`]: object({
    object: RECORD,
    operation: 'button',
    button: button('ESignRecord.Download', 'list'),
    scope: guardScope('esign.recordOwner', NOT_FOUND),
    fields: allFields('F-481 §4.5：files 当前读权允许整份已签文件；ZIP 文件名另检查 owner'),
    guards: ['esign.filesReadable'],
  }),
  [`GET ${ESIGN_BASE}/mine/:id/files`]: own({
    predicate: 'esign.signer',
    target: { param: 'id' },
    locator: 'esign.task',
    denied: NOT_FOUND,
    fields: allFields('F-481 §4.5：签署人本人可读整份已签文件'),
    invalidId: BAD_REQUEST,
  }),
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
  [`GET ${ESIGN_BASE}/template-options/reissue`]: object({
    object: EMPLOYMENT_OBJECT,
    operation: 'update',
    button: button(REISSUE_BUTTON, 'list'),
    scope: NO_SCOPE,
    fields: fixed(['items'], '同 templateOptions，只返回启用模板 id/name'),
  }),
  [`POST ${ESIGN_BASE}/transfer-tasks`]: object({
    object: EMPLOYMENT_OBJECT,
    operation: 'update',
    button: button(REISSUE_BUTTON, 'list'),
    scope: pointScope({ body: 'items[*].businessId' }, 'esign.transferWrite', NOT_FOUND),
    fields: fixed(['items'], '逐条回执仅含提交的 id、ok、code 或 taskId/status/failureReason'),
    write: commandWrite(
      'esign.reissue',
      { generic: { targets: 'items[*].id', locator: 'esign.transferWrite' } },
      { preconditions: ['esign.templates', 'esign.inForce', 'esign.noSigning'] },
    ),
  }),
  [`GET ${ESIGN_BASE}/mine`]: own({
    predicate: 'esign.signer',
    fields: shape('esign.mineList'),
  }),
  [`GET ${ESIGN_BASE}/mine/:id`]: own({
    predicate: 'esign.signer',
    target: { param: 'id' },
    locator: 'esign.ownSignTask',
    denied: NOT_FOUND,
    fields: shape('esign.mineDetail'),
    ...byId,
  }),
  [`POST ${ESIGN_BASE}/mine/:id/sign`]: own({
    predicate: 'esign.signer',
    target: { param: 'id' },
    locator: 'esign.ownSignTask',
    denied: NOT_FOUND,
    fields: fixed(
      ['id', 'revision', 'status', 'currentNode', 'employeeSignedAt', 'enterpriseSignedAt', 'completedAt'],
      '成功只给节点回执；过期为同事务提交的 409 错误信封',
    ),
    write: commandWrite(
      'esign.sign',
      { generic: { targets: 'id', locator: 'esign.ownSignTask' } },
      { controls: ['revision'], preconditions: ['esign.revision', 'esign.currentSigner', 'esign.expiry'] },
    ),
    ...byId,
  }),
});

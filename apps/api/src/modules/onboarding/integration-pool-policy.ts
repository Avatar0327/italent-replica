import { defineTable, type PolicyBase } from '../../route-policy/index.js';
import {
  admin,
  all,
  BAD_REQUEST,
  fixed,
  noButton,
  none,
  noScope,
  object,
  write,
  type WriteExtra,
} from '../../route-policy/presets.js';
import { POOL_SETTINGS, POOL_WRITE_ALIAS } from './integration-pool-access.js';

const DEC = 'R2-T01 §9.3 / DEC-967';
const noOrgScope = noScope('任务池是租户级配置，按当前租户与任职设置授权读写');
const settingsButton = noButton('BE16.IntegrationPoolSettings 登记入口；配置对象由 other_settings 与字段操作权判定');
const options = fixed(['items', 'assessmentTypes'], DEC);
const list = fixed(['items', 'availableActions'], DEC);
const detail = fixed(
  ['id', 'code', 'name', 'description', 'category', 'enabled', 'action', 'revision', 'availableActions'],
  DEC,
);
const actions = fixed(['availableActions'], DEC);
const receipt = fixed(['id', 'revision', 'status'], DEC);
const deleted = fixed([], 'R2-T01 §9.1 删除返回 204');

function settingsOperation(
  operation: 'view' | 'create' | 'update',
  fields: ReturnType<typeof fixed>,
  extra: PolicyBase = {},
) {
  return object({ object: POOL_SETTINGS, operation, button: settingsButton, scope: noOrgScope, fields, ...extra });
}

function settingsWrite(operation: 'create' | 'update', fields: ReturnType<typeof fixed>, extra: PolicyBase = {}) {
  return all(
    [admin('other_settings', { alias: POOL_WRITE_ALIAS, fields }), settingsOperation(operation, fields)],
    fields,
    extra,
  );
}

function poolWritePolicy(extra: WriteExtra = {}) {
  return write(
    { guard: 'onboarding.integrationPoolField' },
    'config.audited:onboarding-integration-task-pool',
    none('仅返回 id、revision、status，当前设置权由命令守卫复核'),
    { ledger: 'single', preconditions: ['assertRevision'], ...extra },
  );
}

export const INTEGRATION_POOL_POLICIES = defineTable('onboarding', {
  'GET /categories': settingsOperation('view', options),
  'GET /': settingsOperation('view', list, { optional: { availableActions: settingsWrite('create', actions) } }),
  'GET /:id': settingsOperation('view', detail, {
    invalidId: BAD_REQUEST,
    optional: { availableActions: settingsWrite('update', actions) },
  }),
  'POST /': settingsWrite('create', receipt, { write: poolWritePolicy() }),
  'PATCH /:id': settingsWrite('update', receipt, { invalidId: BAD_REQUEST, write: poolWritePolicy() }),
  'DELETE /:id': settingsWrite('update', deleted, { invalidId: BAD_REQUEST, write: poolWritePolicy() }),
});

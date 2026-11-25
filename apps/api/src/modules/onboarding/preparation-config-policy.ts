import { defineTable } from '../../route-policy/index.js';
import {
  admin,
  all,
  BAD_REQUEST,
  fixed,
  guardScope,
  listScope,
  noButton,
  noScope,
  NOT_FOUND,
  object,
  projector,
  write,
} from '../../route-policy/presets.js';
import { PREPARATION_SETTINGS } from './preparation-config-scope.js';
import type { PreparationConfigKind } from './preparation-config.js';

const adminRead = admin('other_settings');
const adminWrite = admin('other_settings', { alias: 'tenant.employment.configuration.write' });
const button = noButton('DEC-983 归档沿用租户管理员及任职设置字段更新权');
const tenantScope = noScope('租户级准备事项目录');

function read(kind: PreparationConfigKind, detail = false) {
  const scope =
    kind === 'preparationItems'
      ? tenantScope
      : detail
        ? guardScope('onboarding.preparationRuleScope', NOT_FOUND)
        : listScope('onboarding.preparationRuleScope');
  const fields = projector('onboarding.requirePreparationView', kind);
  return all(
    [adminRead, object({ object: PREPARATION_SETTINGS, operation: 'view', scope, button, fields })],
    fields,
    detail ? { invalidId: BAD_REQUEST } : {},
  );
}

function change(kind: PreparationConfigKind, operation: 'create' | 'update', archive = false) {
  const scope =
    kind === 'preparationItems' && operation === 'create'
      ? tenantScope
      : guardScope('onboarding.preparationConfigScope', NOT_FOUND);
  const fields = fixed(archive ? [] : ['id', 'revision', 'status'], 'R2-T01 §9.1 / DEC-983');
  return all([adminWrite, object({ object: PREPARATION_SETTINGS, operation, scope, button, fields })], fields, {
    ...(operation === 'update' ? { invalidId: BAD_REQUEST } : {}),
    write: write(
      { guard: 'onboarding.requirePreparationWrite' },
      'onboarding.writePreparationConfig',
      'onboarding.preparationConfigScope',
    ),
  });
}

export const PREPARATION_CONFIG_POLICIES = defineTable('onboarding', {
  'GET /preparation-items': read('preparationItems'),
  'GET /preparation-items/:id': read('preparationItems', true),
  'POST /preparation-items': change('preparationItems', 'create'),
  'PATCH /preparation-items/:id': change('preparationItems', 'update'),
  'DELETE /preparation-items/:id': change('preparationItems', 'update', true),
  'GET /preparation-rules': read('preparationRules'),
  'GET /preparation-rules/:id': read('preparationRules', true),
  'POST /preparation-rules': change('preparationRules', 'create'),
  'PATCH /preparation-rules/:id': change('preparationRules', 'update'),
  'DELETE /preparation-rules/:id': change('preparationRules', 'update', true),
});

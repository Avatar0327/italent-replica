import { defineTable } from '../../route-policy/index.js';
import {
  admin,
  BAD_REQUEST,
  all,
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
import { SETTINGS } from './collection-config-scope.js';

const adminConfig = admin('other_settings', { alias: 'tenant.employment.configuration.write' });
const noOrg = noScope('租户级采集设置或模板');
const noConfigButton = noButton('DEC-979 采集设置由租户管理员及任职设置字段操作权判定');

function read(operation: 'list' | 'detail', resource: string) {
  const scope =
    resource === 'collectionRules'
      ? operation === 'list'
        ? listScope('onboarding.ruleScopeSql')
        : guardScope('onboarding.ruleScopeSql', NOT_FOUND)
      : noOrg;
  const fields = projector('onboarding.requireConfigPermission', resource);
  return all(
    [adminConfig, object({ object: SETTINGS, operation: 'view', scope, button: noConfigButton, fields })],
    fields,
    operation === 'detail' && resource !== 'collectionSettings' ? { invalidId: BAD_REQUEST } : {},
  );
}

function change(operation: 'create' | 'update', resource: string, archive = false) {
  const scope =
    resource === 'collectionSettings' || (resource === 'collectionTemplates' && operation === 'create')
      ? noOrg
      : guardScope('onboarding.collectionConfigScope', NOT_FOUND);
  const fields = fixed(archive ? [] : ['id', 'revision', 'status'], 'R2-T01 §9.1 / DEC-979');
  return all([adminConfig, object({ object: SETTINGS, operation, scope, button: noConfigButton, fields })], fields, {
    ...(operation === 'update' && resource !== 'collectionSettings' ? { invalidId: BAD_REQUEST } : {}),
    write: write(
      { guard: 'onboarding.requireConfigPermission' },
      'onboarding.collectionConfigWrite',
      'onboarding.collectionConfigScope',
    ),
  });
}

export const COLLECTION_CONFIG_POLICIES = defineTable('onboarding', {
  'GET /collection-templates': read('list', 'collectionTemplates'),
  'GET /collection-templates/:id': read('detail', 'collectionTemplates'),
  'POST /collection-templates': change('create', 'collectionTemplates'),
  'PATCH /collection-templates/:id': change('update', 'collectionTemplates'),
  'DELETE /collection-templates/:id': change('update', 'collectionTemplates', true),
  'GET /collection-rules': read('list', 'collectionRules'),
  'GET /collection-rules/:id': read('detail', 'collectionRules'),
  'POST /collection-rules': change('create', 'collectionRules'),
  'PATCH /collection-rules/:id': change('update', 'collectionRules'),
  'DELETE /collection-rules/:id': change('update', 'collectionRules', true),
  'GET /collection-settings': read('detail', 'collectionSettings'),
  'PUT /collection-settings': change('update', 'collectionSettings'),
});

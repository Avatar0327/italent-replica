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
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { MATERIAL } from './material-list.js';
import { SETTINGS } from './collection-config-scope.js';

const adminRead = admin('other_settings');
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
  const fields = projector('onboarding.requireConfigView', resource);
  return all(
    [adminRead, object({ object: SETTINGS, operation: 'view', scope, button: noConfigButton, fields })],
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
      { guard: 'onboarding.requireConfigWrite' },
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

function materialConfigRead(detail: boolean) {
  const fields = projector('onboarding.requireMaterialConfigView', 'materialRules');
  const scope = detail
    ? guardScope('onboarding.materialRuleScope', NOT_FOUND)
    : listScope('onboarding.materialRuleScope');
  return all(
    [
      adminRead,
      object({
        object: SETTINGS,
        operation: 'view',
        scope,
        button: noButton('DEC-983 材料设置按租户管理员和对应字段权限判定'),
        fields,
      }),
    ],
    fields,
    detail ? { invalidId: BAD_REQUEST } : {},
  );
}

function materialConfigChange(operation: 'create' | 'update', archive = false) {
  const fields = fixed(archive ? [] : ['id', 'revision', 'status'], 'R2-T01 §9.1 / DEC-983');
  const scope = guardScope('onboarding.materialConfigScope', NOT_FOUND);
  return all(
    [
      adminConfig,
      object({
        object: SETTINGS,
        operation,
        scope,
        button: noButton('DEC-983 规则归档使用任职设置对应字段编辑权'),
        fields,
      }),
    ],
    fields,
    {
      ...(operation === 'update' ? { invalidId: BAD_REQUEST } : {}),
      write: write(
        { guard: 'onboarding.requireMaterialConfigWrite' },
        'onboarding.writeMaterialRule',
        'onboarding.materialConfigScope',
      ),
    },
  );
}

function materialListRead() {
  const fields = projector('onboarding.readMaterialList', 'onboarding.materialList');
  const scope = guardScope('onboarding.materialEntryScope', NOT_FOUND);
  return all(
    [EMPLOYMENT_OBJECT, MATERIAL].map((code) =>
      object({
        object: code,
        operation: 'view',
        scope,
        button: noButton('清单读取核双对象和当前范围'),
        fields,
      }),
    ),
    fields,
    { invalidId: BAD_REQUEST },
  );
}

export const MATERIAL_POLICIES = defineTable('onboarding', {
  'GET /material-rules': materialConfigRead(false),
  'GET /material-rules/:id': materialConfigRead(true),
  'POST /material-rules': materialConfigChange('create'),
  'PATCH /material-rules/:id': materialConfigChange('update'),
  'DELETE /material-rules/:id': materialConfigChange('update', true),
  'GET /entries/:businessId/materials': materialListRead(),
});

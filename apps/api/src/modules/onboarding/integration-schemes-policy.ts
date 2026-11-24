import { defineTable } from '../../route-policy/index.js';
import {
  admin,
  all,
  BAD_REQUEST,
  fixed,
  guardScope,
  listScope,
  noButton,
  NOT_FOUND,
  object,
  pointScope,
  write,
} from '../../route-policy/presets.js';
import type { PolicyBase, ScopePolicy } from '../../route-policy/types.js';
import { SCHEME_SETTINGS, SCHEME_WRITE_ALIAS } from './integration-schemes-access.js';

const DEC = 'R2-T01 §7.1、§9.3 / DEC-967';
const list = fixed(['items', 'availableActions'], DEC);
const detail = fixed(
  [
    'id',
    'name',
    'priority',
    'description',
    'failureRecipientId',
    'orgIds',
    'conditions',
    'reminder',
    'stages',
    'revision',
    'availableActions',
  ],
  DEC,
);
const receipt = fixed(['id', 'revision', 'status'], DEC);
const actions = fixed(['availableActions'], DEC);
const orgList = listScope('onboarding.schemeScopeSql');
const orgPoint = pointScope({ param: 'id' }, 'onboarding.readScheme', NOT_FOUND);
const orgInput = guardScope('onboarding.requireSchemeOrgs', NOT_FOUND);
const schemeAccessButton = noButton('BE16.IntegrationSchemeSettings 由 other_settings 与任职设置字段权承载');

type Operation = 'view' | 'create' | 'update';
function operation(op: Operation, fields: typeof detail, scope: ScopePolicy) {
  return object({ object: SCHEME_SETTINGS, operation: op, button: schemeAccessButton, scope, fields });
}
function schemeAccess(op: Operation, fields: typeof detail, scope: ScopePolicy, extra: PolicyBase = {}) {
  return all(
    [
      admin('other_settings', { ...(op === 'view' ? {} : { alias: SCHEME_WRITE_ALIAS }), fields }),
      operation(op, fields, scope),
    ],
    fields,
    extra,
  );
}
const mutation = write(
  { guard: 'onboarding.integrationSchemesField' },
  'config.audited:onboarding-integration-scheme',
  'onboarding.requireSchemeResultScope',
  { ledger: 'single', preconditions: ['assertRevision'] },
);

export const INTEGRATION_SCHEME_POLICIES = defineTable('onboarding', {
  'GET /schemes': schemeAccess('view', list, orgList, {
    optional: { availableActions: operation('create', actions, orgList) },
  }),
  'GET /schemes/:id': schemeAccess('view', detail, orgPoint, {
    invalidId: BAD_REQUEST,
    optional: { availableActions: operation('update', actions, orgPoint) },
  }),
  'POST /schemes': schemeAccess('create', receipt, orgInput, { write: mutation }),
  'PATCH /schemes/:id': schemeAccess('update', receipt, orgPoint, { invalidId: BAD_REQUEST, write: mutation }),
  'DELETE /schemes/:id': schemeAccess('update', fixed([], 'R2-T01 §9.1'), orgPoint, {
    invalidId: BAD_REQUEST,
    write: mutation,
  }),
});

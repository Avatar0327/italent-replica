import type { ButtonDefinition, DataOperation } from '../permission/object-permission.js';

function action(name: string, level: ButtonDefinition['level'], requires?: DataOperation): ButtonDefinition {
  return { code: `BE16.${name}`, level, ...(requires ? { requires } : {}) };
}

const rowAndDetail = (name: string, requires: DataOperation) =>
  [action(name, 'list_row', requires), action(name, 'detail', requires)] as const;

/** R2-T01 §9.2～9.3。双对象操作的按钮放在任职记录，业务对象 CRUD 和范围由写入口独立验证。 */
export const ONBOARDING_BUTTONS = {
  employmentRecord: [
    ...rowAndDetail('CollectionStart', 'update'),
    ...rowAndDetail('CollectionRemind', 'update'),
    action('CollectionComment', 'detail', 'update'),
    action('CollectionStartBatch', 'list', 'update'),
    action('CollectionConfirmRehire', 'detail', 'update'),
    ...rowAndDetail('PreparationStart', 'update'),
    ...rowAndDetail('PreparationRemind', 'update'),
    action('MaterialSubmit', 'detail', 'update'),
    action('MaterialReceive', 'detail', 'update'),
    ...rowAndDetail('MaterialRemind', 'update'),
  ],
  qrCode: [action('QrManage', 'list', 'update'), action('QrShare', 'detail')],
  preparation: [
    action('PreparationComplete', 'detail', 'update'),
    action('PreparationCompleteBatch', 'list', 'update'),
  ],
  integration: [
    action('IntegrationStart', 'list_row', 'create'),
    action('IntegrationStartBatch', 'list', 'create'),
    action('IntegrationTerminate', 'detail', 'update'),
    action('IntegrationRestart', 'detail', 'update'),
    action('IntegrationSyncTaskText', 'detail', 'update'),
    action('IntegrationRemind', 'detail', 'update'),
    action('IntegrationComplete', 'detail', 'update'),
  ],
  // 设置页沿现有 other_settings 和字段 CRUD 判定。这里登记的是配置动作的稳定编码。
  settings: [
    'CollectionSettings',
    'AddSchemeSettings',
    'PreparationItemSettings',
    'PreparationRuleSettings',
    'MaterialSettings',
    'RequirementSettings',
    'WelcomeSettings',
    'HandbookSettings',
    'IntegrationPoolSettings',
    'IntegrationSchemeSettings',
  ].map((name) => action(name, 'list', 'update')),
} as const;

export const ONBOARDING_FORM_FIELDS = {
  collection: ['comment'],
  collectionApproval: ['collectionValues'],
  settings: [
    'collectionTemplates',
    'collectionRules',
    'collectionSettings',
    'addSchemes',
    'preparationItems',
    'preparationRules',
    'materialRules',
    'entryRequirements',
    'welcomeLetters',
    'handbooks',
    'integrationTaskPool',
    'integrationSchemes',
    'integrationSettings',
  ],
} as const;

export const ENTRY_INFO_COLLECTION_PROCESS = 'EntryInfoCollectionProcess';

export const ONBOARDING_ENTRY_STATUS_FIELDS: readonly string[] = [
  'collectionStatus',
  'preparationStatus',
  'materialStatus',
];

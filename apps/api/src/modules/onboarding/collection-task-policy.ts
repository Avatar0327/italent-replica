import { PERSONNEL_OBJECT, SUBSETS } from '@italent/domain';
import { defineTable } from '../../route-policy/index.js';
import {
  all,
  BAD_REQUEST,
  button,
  fixed,
  guardScope,
  noButton,
  noFields,
  none,
  NOT_FOUND,
  object,
  projector,
  write,
} from '../../route-policy/presets.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { COLLECTION, COLLECTION_BUTTONS, type WriteAction } from './collection-access.js';

const scope = guardScope('onboarding.requireCollectionTarget', NOT_FOUND);

function carriers(fields: ReturnType<typeof projector> | ReturnType<typeof fixed>) {
  return [EMPLOYMENT_OBJECT, COLLECTION].map((code) =>
    object({ object: code, operation: 'view', scope, button: noButton('采集详情须有双对象查看及范围'), fields }),
  );
}

function taskWrite(action: WriteAction) {
  const mapped = COLLECTION_BUTTONS[action];
  const fields = fixed(
    action === 'batch'
      ? ['items.id', 'items.revision', 'items.status', 'items.code']
      : ['id', 'revision', 'status', 'notificationStatus'],
    'R2-T01 §9.1 采集仅回最小状态',
  );
  const objectButton = button(mapped.code, mapped.level);
  return all(
    [
      ...carriers(fields),
      object({
        object: EMPLOYMENT_OBJECT,
        operation: 'update',
        scope,
        button: objectButton,
        fields,
        ...(action === 'batch'
          ? {
              rows: {
                path: 'targets[*]',
                target: { body: 'targets[*].id' },
                fields: none('待入职标识及版本是控制项'),
                batch: 'receipt' as const,
              },
            }
          : {}),
      }),
      object({
        object: COLLECTION,
        operation: action === 'start' || action === 'batch' ? 'create' : 'update',
        scope,
        button: noButton('采集业务按钮由任职对象判定'),
        fields,
      }),
    ],
    fields,
    {
      ...(action === 'batch' ? {} : { invalidId: BAD_REQUEST }),
      write: write(
        { guard: 'onboarding.requireCollectionWrite' },
        'onboarding.requireCollectionTarget',
        action === 'batch' ? 'onboarding.visibleBatchItems' : 'onboarding.requireCollectionTarget',
        {
          ledger: action === 'batch' ? 'perItem' : 'single',
          controls: ['businessId', 'businessRevision', 'caseRevision'],
          preconditions: ['onboarding.lockCollectionEntry'],
        },
      ),
    },
  );
}

const detail = projector('onboarding.projectCollectionTask', 'onboarding.collectionTask');
const form = projector('onboarding.visibleForm', 'onboarding.collectionTaskForm');
function formObject(code: string) {
  return object({
    object: code,
    operation: 'view',
    button: noButton('仅披露采集配置中当前可见的字段'),
    scope: guardScope('onboarding.visibleForm', NOT_FOUND),
    fields: form,
  });
}
const actions = noFields('仅决定采集任务可用动作');
const availableActions = all(
  [
    object({
      object: EMPLOYMENT_OBJECT,
      operation: 'update',
      scope,
      fields: actions,
      button: button('BE16.CollectionStart', 'detail'),
    }),
    object({
      object: EMPLOYMENT_OBJECT,
      operation: 'button',
      scope,
      fields: actions,
      button: button('BE16.CollectionComment', 'detail'),
    }),
    ...(['create', 'update'] as const).map((operation) =>
      object({
        object: COLLECTION,
        operation,
        scope,
        fields: actions,
        button: noButton('按钮由任职对象判定'),
      }),
    ),
  ],
  actions,
);
export const COLLECTION_TASK_POLICIES = defineTable('onboarding', {
  'GET /entries/:businessId/collection': all(carriers(detail), detail, {
    invalidId: BAD_REQUEST,
    optional: {
      availableActions,
      profile: formObject(PERSONNEL_OBJECT),
      education: formObject(SUBSETS.education.objectCode),
      certificate: formObject(SUBSETS.certificate.objectCode),
    },
  }),
  'POST /entries/:businessId/collection/start': taskWrite('start'),
  'POST /entries/:businessId/collection/remind': taskWrite('remind'),
  'POST /entries/:businessId/collection/comments': taskWrite('comments'),
  'POST /collection/start-batch': taskWrite('batch'),
});

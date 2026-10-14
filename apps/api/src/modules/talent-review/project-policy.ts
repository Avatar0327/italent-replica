/** R3-T04 B7a（设计 §6.1 / §7）：管理 / 公开 / 共享范围；项目写入统一只读守卫。 */
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import {
  BAD_REQUEST,
  button,
  guardScope,
  listScope,
  noButton,
  none,
  NOT_FOUND,
  object,
  pointScope,
  projector,
  write,
} from '../../route-policy/presets.js';

const BASE = '/api/tenant/talent-review/projects';
const PROJECT = TALENT_REVIEW_OBJECTS.project.code;
const fields = projector('talentReview.project', 'talentReview.project');
const point = pointScope({ param: 'id' }, 'talentReview.project.byId', NOT_FOUND);
const readonly = 'talentReview.projectReadonly';
const reference = ['talentReview.projectCatalogReference'];
const changed = (action: string) =>
  write(
    action === 'create' || action === 'update' ? 'body' : none('无人工配置字段'),
    'talentReview.commandScope',
    { generic: { targets: 'id', locator: 'talentReview.project.byId' } },
    { ledger: 'single' },
  );
const change = (action: 'create' | 'update' | 'delete' | 'start' | 'end' | 'restart') =>
  object({
    ...(action === 'create' ? {} : { invalidId: BAD_REQUEST }),
    object: PROJECT,
    operation: action === 'create' || action === 'delete' ? action : 'update',
    button: button(action, action === 'create' ? 'list' : 'detail'),
    scope: action === 'create' ? guardScope('talentReview.projectCreatable', NOT_FOUND) : point,
    fields,
    guards: [readonly, ...(action === 'create' || action === 'update' ? reference : [])],
    write: changed(action),
  });
export const PROJECT_POLICIES = {
  [`GET ${BASE}`]: object({
    object: PROJECT,
    operation: 'view',
    button: noButton('列表查看权'),
    scope: listScope('talentReview.projectScope'),
    fields,
  }),
  [`GET ${BASE}/:id`]: object({
    invalidId: BAD_REQUEST,
    object: PROJECT,
    operation: 'view',
    button: noButton('详情查看权'),
    scope: point,
    fields,
  }),
  [`POST ${BASE}`]: change('create'),
  [`PATCH ${BASE}/:id`]: change('update'),
  [`DELETE ${BASE}/:id`]: change('delete'),
  [`POST ${BASE}/:id/start`]: change('start'),
  [`POST ${BASE}/:id/end`]: change('end'),
  [`POST ${BASE}/:id/restart`]: change('restart'),
};

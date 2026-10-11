/**
 * R3-T04 PR-B6a 盘点模板路由的权限声明（F-039；并入 policy.ts 的 TALENT_REVIEW_POLICIES）。模板有所属组织：数据范围按（用户 × TalentReview）
 * 的组织范围 ∪ 创建人，可向下公开（下级可查看与选用，不可修改，403 TEMPLATE_PUBLIC_DOWN_READONLY）；范围外与不存在同为 404；
 * 新建 / 改所属组织要求目标组织在范围内。引用流程 / 评价规则 / 模块等级 / 盘点字段 = 读取对应目录：请求带引用时另需目录对象的查看权，
 * 引用的可见性在命令内按目录范围判定。路由声明文档见 docs/08_设计/R3-T04_PR-B6a_路由声明.md。
 */
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

const BASE = '/api/tenant/talent-review/templates';
const TPL = TALENT_REVIEW_OBJECTS.template.code;
const byId = { invalidId: BAD_REQUEST };
const fields = projector('talentReview.template', 'talentReview.template');
const point = pointScope({ param: 'id' }, 'talentReview.template.byId', NOT_FOUND);
const result = { generic: { targets: 'id', locator: 'talentReview.template.byId' } } as const;
const changed = (body: 'body' | 'none') =>
  write(body === 'body' ? 'body' : none('删除不写字段'), 'talentReview.commandScope', result, { ledger: 'single' });
const REFERENCE = 'talentReview.templateCatalogReference';
const READONLY = 'talentReview.templatePublicDownReadonly';

export const TEMPLATE_POLICIES = {
  [`GET ${BASE}`]: object({
    object: TPL,
    operation: 'view',
    button: noButton('列表按对象查看权'),
    scope: listScope('talentReview.templateReadable'),
    fields,
    guards: ['talentReview.filterFieldVisible'],
  }),
  [`GET ${BASE}/:id`]: object({
    ...byId,
    object: TPL,
    operation: 'view',
    button: noButton('详情按对象查看权'),
    scope: point,
    fields,
  }),
  // 新建：所属组织须在范围内（不因创建人或向下公开放行），范围外 404
  [`POST ${BASE}`]: object({
    object: TPL,
    operation: 'create',
    button: button('create', 'list'),
    scope: guardScope('talentReview.templateCreatable', NOT_FOUND),
    fields,
    guards: [REFERENCE],
    write: changed('body'),
  }),
  [`PATCH ${BASE}/:id`]: object({
    ...byId,
    object: TPL,
    operation: 'update',
    button: button('update', 'detail'),
    scope: point,
    fields,
    guards: [READONLY, REFERENCE],
    write: changed('body'),
  }),
  [`DELETE ${BASE}/:id`]: object({
    ...byId,
    object: TPL,
    operation: 'delete',
    button: button('delete', 'detail'),
    scope: point,
    fields,
    guards: [READONLY],
    write: changed('none'),
  }),
};

/**
 * R3-T04 PR-B5 计算规则路由的权限声明（F-039；并入 policy.ts 的 TALENT_REVIEW_POLICIES）。计算规则没有组织字段，只认看全部或
 * 创建人（DEC-121），新建只有看全部可建（DEC-082）；改名要求看全部（NAME_REQUIRES_SEE_ALL，判定在查重之前）；提交计算项目
 * 另需字段目录的对象查看权（公式与目标字段只在其可见字段里解析）。路由声明文档见 docs/08_设计/R3-T04_PR-B5_路由声明.md。
 */
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import {
  BAD_REQUEST,
  button,
  listScope,
  noButton,
  none,
  NOT_FOUND,
  object,
  projector,
  seeAll,
  write,
} from '../../route-policy/presets.js';

const BASE = '/api/tenant/talent-review/calc-rules';
const CALC = TALENT_REVIEW_OBJECTS.calcRule.code;
const byId = { invalidId: BAD_REQUEST };
const fields = projector('talentReview.calcRule', 'talentReview.calcRule');
const point = seeAll(NOT_FOUND, { creatorLocator: 'talentReview.calcRule.createdBy' });
const result = { generic: { targets: 'id', locator: 'talentReview.calcRule.byId' } } as const;
const changed = (body: 'body' | 'none') =>
  write(body === 'body' ? 'body' : none('删除不写字段'), 'talentReview.commandScope', result, { ledger: 'single' });

export const CALC_RULE_POLICIES = {
  [`GET ${BASE}`]: object({
    object: CALC,
    operation: 'view',
    button: noButton('列表按对象查看权'),
    scope: listScope('talentReview.configScope(talent_review_calc_rules)'),
    fields,
    guards: ['talentReview.filterFieldVisible'],
  }),
  [`GET ${BASE}/:id`]: object({
    ...byId,
    object: CALC,
    operation: 'view',
    button: noButton('详情按对象查看权'),
    scope: point,
    fields,
  }),
  [`POST ${BASE}`]: object({
    object: CALC,
    operation: 'create',
    button: button('create', 'list'),
    scope: seeAll(NOT_FOUND),
    fields,
    guards: ['talentReview.calcRuleFieldCatalog'],
    write: changed('body'),
  }),
  [`PATCH ${BASE}/:id`]: object({
    ...byId,
    object: CALC,
    operation: 'update',
    button: button('update', 'detail'),
    scope: point,
    fields,
    guards: ['talentReview.configRenameRequiresSeeAll', 'talentReview.calcRuleFieldCatalog'],
    write: changed('body'),
  }),
  [`DELETE ${BASE}/:id`]: object({
    ...byId,
    object: CALC,
    operation: 'delete',
    button: button('delete', 'detail'),
    scope: point,
    fields,
    write: changed('none'),
  }),
};

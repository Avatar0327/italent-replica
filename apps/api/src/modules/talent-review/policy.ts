/**
 * 人才盘点路由的现状声明（F-039 PR-A；按已合并的 docs/08_设计/R3-T04_准备度字典_路由声明.md 5 条原样转写，
 * 处理函数不变）。挂在 /api/tenant/talent-review 之下，应用 TalentReview（DEC-043：范围按 用户 × TalentReview，缺省为空）。
 * 准备度 RDY 是没有组织字段的设置类配置对象：只认看全部或创建人（DEC-121），新建只有看全部可建（DEC-082）。
 */
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { defineTable } from '../../route-policy/index.js';
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

const PATH = '/api/tenant/talent-review/readiness-levels';
const RDY = TALENT_REVIEW_OBJECTS.readiness.code;
const byId = { invalidId: BAD_REQUEST };
const OUT = projector('talentReview.readiness', 'talentReview.readiness');
/** 详情 / 写入：看全部或创建人（requireConfigVisible），范围外与不存在同为 404。 */
const POINT = seeAll(NOT_FOUND, { creatorLocator: 'talentReview.readiness.createdBy' });
const result = { generic: { targets: 'id', locator: 'talentReview.readiness.byId' } } as const;
const rdyWrite = (fields: 'body' | 'none') =>
  write(fields === 'body' ? 'body' : none('删除不写字段'), 'talentReview.commandScope', result, { ledger: 'single' });

export const TALENT_REVIEW_POLICIES = defineTable('talent-review', {
  // 带 enabled 筛选而无 enabled 字段查看权 → 403 FILTER_FIELD_HIDDEN（requireFilterVisible）
  [`GET ${PATH}`]: object({
    object: RDY,
    operation: 'view',
    button: noButton('列表按对象查看权'),
    scope: listScope('talentReview.configScope(talent_readiness_levels)'),
    fields: OUT,
    guards: ['talentReview.filterFieldVisible'],
  }),
  [`GET ${PATH}/:id`]: object({
    ...byId,
    object: RDY,
    operation: 'view',
    button: noButton('详情按对象查看权'),
    scope: POINT,
    fields: OUT,
  }),
  // 新建只有看全部可建（requireConfigCreatable，否则 404）
  [`POST ${PATH}`]: object({
    object: RDY,
    operation: 'create',
    button: button('create', 'list'),
    scope: seeAll(NOT_FOUND),
    fields: OUT,
    write: rdyWrite('body'),
  }),
  // 名称实际变化要求看全部（只有创建人范围时 403 READINESS_NAME_REQUIRES_SEE_ALL，判定在查重之前）
  [`PATCH ${PATH}/:id`]: object({
    ...byId,
    object: RDY,
    operation: 'update',
    button: button('update', 'detail'),
    scope: POINT,
    fields: OUT,
    guards: ['talentReview.renameRequiresSeeAll'],
    write: rdyWrite('body'),
  }),
  [`DELETE ${PATH}/:id`]: object({
    ...byId,
    object: RDY,
    operation: 'delete',
    button: button('delete', 'detail'),
    scope: POINT,
    fields: OUT,
    write: rdyWrite('none'),
  }),
});

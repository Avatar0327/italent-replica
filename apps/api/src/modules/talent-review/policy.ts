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
  fixed,
  listScope,
  noButton,
  none,
  NOT_FOUND,
  object,
  projector,
  seeAll,
  write,
} from '../../route-policy/presets.js';
import { MATRIX_POLICIES } from './matrix-policy.js';
import { CALC_RULE_POLICIES } from './calc-rule-policy.js';

/**
 * 字段改名失败（FIELD_NAME_BREAKS_FORMULA，F-082 契约 §3.1）时错误载荷里的定位信息：可选分支，只决定披露什么、不参与准入、
 * 不拒绝请求——没有计算规则查看权（范围内）或 items 列查看权的人只得到匿名计数（DEC-376①）。
 */
const RENAME_BREAKS_DISCLOSURE = object({
  object: TALENT_REVIEW_OBJECTS.calcRule.code,
  operation: 'view',
  button: noButton('只取对象查看权与字段查看权'),
  scope: listScope('talentReview.configScope(talent_review_calc_rules)'),
  fields: fixed(['items'], 'DEC-376', TALENT_REVIEW_OBJECTS.calcRule.code),
});

const PATH = '/api/tenant/talent-review/readiness-levels';
const RDY = TALENT_REVIEW_OBJECTS.readiness.code;
const byId = { invalidId: BAD_REQUEST };
const OUT = projector('talentReview.readiness', 'talentReview.readiness');
/** 详情 / 写入：看全部或创建人（requireConfigVisible），范围外与不存在同为 404。 */
const POINT = seeAll(NOT_FOUND, { creatorLocator: 'talentReview.readiness.createdBy' });
const result = { generic: { targets: 'id', locator: 'talentReview.readiness.byId' } } as const;
const rdyWrite = (fields: 'body' | 'none') =>
  write(fields === 'body' ? 'body' : none('删除不写字段'), 'talentReview.commandScope', result, { ledger: 'single' });

/**
 * R3-T04 PR-B1 配置对象（分类 / 角色 / 字段目录）：与准备度同一现状——没有组织字段，只认看全部或创建人（DEC-121），
 * 新建只有看全部可建（DEC-082）；改名要求看全部（NAME_REQUIRES_SEE_ALL，判定在查重之前）。路由声明文档见
 * docs/08_设计/R3-T04_PR-B1_路由声明.md。
 */
function configRoutes(
  key: 'category' | 'role' | 'field' | 'scoreRule' | 'moduleGrade' | 'mapping',
  path: string,
  table: string,
  options: { createGuards?: readonly string[]; renameGuard?: boolean; updateGuards?: readonly string[] } = {},
) {
  const { createGuards = [], renameGuard = true, updateGuards = [] } = options;
  const code = TALENT_REVIEW_OBJECTS[key].code;
  const fields = projector(`talentReview.${key}`, `talentReview.${key}`);
  const point = seeAll(NOT_FOUND, { creatorLocator: `talentReview.${key}.createdBy` });
  const result = { generic: { targets: 'id', locator: `talentReview.${key}.byId` } } as const;
  const changed = (body: 'body' | 'none') =>
    write(body === 'body' ? 'body' : none('删除不写字段'), 'talentReview.commandScope', result, { ledger: 'single' });
  return {
    [`GET ${path}`]: object({
      object: code,
      operation: 'view',
      button: noButton('列表按对象查看权'),
      scope: listScope(`talentReview.configScope(${table})`),
      fields,
      guards: ['talentReview.filterFieldVisible'],
    }),
    [`GET ${path}/:id`]: object({
      ...byId,
      object: code,
      operation: 'view',
      button: noButton('详情按对象查看权'),
      scope: point,
      fields,
    }),
    [`POST ${path}`]: object({
      object: code,
      operation: 'create',
      button: button('create', 'list'),
      scope: seeAll(NOT_FOUND),
      fields,
      guards: createGuards,
      write: changed('body'),
    }),
    [`PATCH ${path}/:id`]: object({
      ...byId,
      object: code,
      operation: 'update',
      button: button('update', 'detail'),
      scope: point,
      fields,
      guards: [...(renameGuard ? ['talentReview.configRenameRequiresSeeAll'] : []), ...updateGuards],
      write: changed('body'),
      ...(key === 'field' ? { optional: { renameBreaksDisclosure: RENAME_BREAKS_DISCLOSURE } } : {}),
    }),
    [`DELETE ${path}/:id`]: object({
      ...byId,
      object: code,
      operation: 'delete',
      button: button('delete', 'detail'),
      scope: point,
      fields,
      write: changed('none'),
    }),
  };
}

const SETTINGS = '/api/tenant/talent-review/settings';
const SETTINGS_CODE = TALENT_REVIEW_OBJECTS.settings.code;
const SETTINGS_FIELDS = projector('talentReview.settings', 'talentReview.settings');

export const TALENT_REVIEW_POLICIES = defineTable('talent-review', {
  ...MATRIX_POLICIES,
  ...CALC_RULE_POLICIES,
  ...configRoutes('category', '/api/tenant/talent-review/categories', 'talent_review_categories'),
  ...configRoutes('role', '/api/tenant/talent-review/roles', 'talent_review_roles'),
  // 新建时指定成对字段 = 同时修改另一端：另需更新权、update 按钮与 pairFieldId 编辑权（requirePairUpdate）
  ...configRoutes('field', '/api/tenant/talent-review/fields', 'talent_review_fields', {
    createGuards: ['talentReview.pairRequiresUpdate'],
  }),
  // PR-B2：评价规则、模块等级（有名称，改名要求看全部）与字段映射（无名称；引用字段 = 读取字段对象，另需其查看权与范围）
  ...configRoutes('scoreRule', '/api/tenant/talent-review/score-rules', 'talent_review_score_rules'),
  ...configRoutes('moduleGrade', '/api/tenant/talent-review/module-grades', 'talent_review_module_grades'),
  ...configRoutes('mapping', '/api/tenant/talent-review/field-mappings', 'talent_review_field_mappings', {
    createGuards: ['talentReview.mappingFieldVisible'],
    updateGuards: ['talentReview.mappingFieldVisible'],
    renameGuard: false,
  }),
  // 租户设置是单例：读写都只有看全部（requireConfigCreatable，否则 404）；没有记录时返回默认值与 revision 0
  [`GET ${SETTINGS}`]: object({
    object: SETTINGS_CODE,
    operation: 'view',
    button: noButton('单例按对象查看权'),
    scope: seeAll(NOT_FOUND),
    fields: SETTINGS_FIELDS,
  }),
  [`PATCH ${SETTINGS}`]: object({
    object: SETTINGS_CODE,
    operation: 'update',
    button: button('update', 'detail'),
    scope: seeAll(NOT_FOUND),
    fields: SETTINGS_FIELDS,
    write: write(
      'body',
      'talentReview.commandScope',
      { generic: { targets: 'id', locator: 'talentReview.settings.singleton' } },
      {
        ledger: 'single',
      },
    ),
  }),
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

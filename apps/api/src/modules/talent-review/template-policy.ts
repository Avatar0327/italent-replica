/**
 * R3-T04 PR-B6a 盘点模板路由的权限声明（F-039；并入 policy.ts 的 TALENT_REVIEW_POLICIES）。模板有所属组织：数据范围按（用户 × TalentReview）
 * 的组织范围 ∪ 创建人，可向下公开（下级可查看与选用，不可修改，403 TEMPLATE_PUBLIC_DOWN_READONLY）；范围外与不存在同为 404；
 * 新建 / 改所属组织要求目标组织在范围内。引用流程 / 评价规则 / 模块等级 / 盘点字段 = 读取对应目录：请求带引用时另需目录对象的查看权，
 * 引用的可见性在命令内按目录范围判定。路由声明文档见 docs/08_设计/R3-T04_PR-B6a_路由声明.md。
 */
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import {
  all,
  BAD_REQUEST,
  button,
  guardScope,
  fixed,
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
// F-082：字段目录权限仅决定公式的引用披露，没有访问时显示占位符，不拒绝模板读取。
const resultFields = object({
  object: TALENT_REVIEW_OBJECTS.field.code,
  operation: 'view',
  button: noButton('公式引用披露'),
  scope: listScope('talentReview.configScope(talent_review_fields)'),
  fields: fixed(['name', 'kind', 'enabled', 'systemWritten'], 'F-082 引用投影', TALENT_REVIEW_OBJECTS.field.code),
});
const optional = { resultFields };

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
    optional,
  }),
  // 新建：所属组织须在范围内（不因创建人或向下公开放行），范围外 404
  [`POST ${BASE}`]: object({
    object: TPL,
    operation: 'create',
    button: button('create', 'list'),
    scope: guardScope('talentReview.templateCreatable', NOT_FOUND),
    fields,
    optional,
    // 重放：首次成功后模板被改成只读（向下公开）时，同键重放按当前归属拒绝（guard.replayed 的 requireEditable）
    guards: [READONLY, REFERENCE],
    write: changed('body'),
  }),
  [`POST ${BASE}/:id/copy`]: all(
    [
      object({
        object: TPL,
        operation: 'create',
        button: button('copy', 'list'),
        scope: guardScope('talentReview.templateCreatable', NOT_FOUND),
        fields,
      }),
      object({ object: TPL, operation: 'view', button: noButton('复制读取原模板'), scope: point, fields }),
    ],
    fields,
    { ...byId, optional, guards: [READONLY, REFERENCE], write: changed('body') },
  ),
  [`PATCH ${BASE}/:id`]: object({
    ...byId,
    object: TPL,
    operation: 'update',
    button: button('update', 'detail'),
    scope: point,
    fields,
    optional,
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
    optional,
    guards: [READONLY],
    write: changed('none'),
  }),
};

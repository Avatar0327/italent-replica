/**
 * R3-T04 PR-B4 九宫格路由的权限声明（F-039；并入 policy.ts 的 TALENT_REVIEW_POLICIES）。九宫格没有组织字段，只认看全部或创建人
 * （DEC-121），新建只有看全部可建（DEC-082）；改名要求看全部（NAME_REQUIRES_SEE_ALL）、改位置字段要求看全部
 * （MATRIX_POSITION_REQUIRES_SEE_ALL），判定都在查重之前；引用盘点字段（轴 / 位置字段）另需字段目录的对象查看权，
 * 字段可见性在命令内按字段目录范围判定。规则组写入是九宫格的 update。路由声明文档见 docs/08_设计/R3-T04_PR-B4_路由声明.md。
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

const BASE = '/api/tenant/talent-review/matrices';
const MTX = TALENT_REVIEW_OBJECTS.matrix.code;
const byId = { invalidId: BAD_REQUEST };
const fields = projector('talentReview.matrix', 'talentReview.matrix');
const point = seeAll(NOT_FOUND, { creatorLocator: 'talentReview.matrix.createdBy' });
const result = { generic: { targets: 'id', locator: 'talentReview.matrix.byId' } } as const;
const changed = (body: 'body' | 'none') =>
  write(body === 'body' ? 'body' : none('删除不写字段'), 'talentReview.commandScope', result, { ledger: 'single' });

export const MATRIX_POLICIES = {
  [`GET ${BASE}`]: object({
    object: MTX,
    operation: 'view',
    button: noButton('列表按对象查看权'),
    scope: listScope('talentReview.configScope(talent_review_matrices)'),
    fields,
    guards: ['talentReview.filterFieldVisible'],
  }),
  [`GET ${BASE}/:id`]: object({
    ...byId,
    object: MTX,
    operation: 'view',
    button: noButton('详情按对象查看权'),
    scope: point,
    fields,
  }),
  [`POST ${BASE}`]: object({
    object: MTX,
    operation: 'create',
    button: button('create', 'list'),
    scope: seeAll(NOT_FOUND),
    fields,
    guards: ['talentReview.matrixFieldReference'],
    write: changed('body'),
  }),
  [`PATCH ${BASE}/:id`]: object({
    ...byId,
    object: MTX,
    operation: 'update',
    button: button('update', 'detail'),
    scope: point,
    fields,
    guards: [
      'talentReview.configRenameRequiresSeeAll',
      'talentReview.matrixPositionRequiresSeeAll',
      'talentReview.matrixFieldReference',
    ],
    write: changed('body'),
  }),
  [`DELETE ${BASE}/:id`]: object({
    ...byId,
    object: MTX,
    operation: 'delete',
    button: button('delete', 'detail'),
    scope: point,
    fields,
    write: changed('none'),
  }),
  // 规则组是九宫格聚合的一部分：权限 = 九宫格 update 操作 + update 按钮 + ratioGroups 字段编辑权，范围同九宫格
  [`POST ${BASE}/:id/ratio-groups`]: object({
    ...byId,
    object: MTX,
    operation: 'update',
    button: button('update', 'detail'),
    scope: point,
    fields,
    write: changed('body'),
  }),
  [`PATCH ${BASE}/:id/ratio-groups/:groupId`]: object({
    ...byId,
    object: MTX,
    operation: 'update',
    button: button('update', 'detail'),
    scope: point,
    fields,
    write: changed('body'),
  }),
  [`DELETE ${BASE}/:id/ratio-groups/:groupId`]: object({
    ...byId,
    object: MTX,
    operation: 'update',
    button: button('update', 'detail'),
    scope: point,
    fields,
    // 删除规则组 = 清掉 ratioGroups 的一项：同样校验 ratioGroups 的字段编辑权（载荷是常量，不来自请求体）
    write: changed('body'),
  }),
};

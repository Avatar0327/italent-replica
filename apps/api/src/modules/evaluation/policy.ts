/**
 * 人才评定配置路由的现状声明（F-039；按 docs/08_设计/R3-T02-B1a_评定底座与活动类型_路由声明.md 转写，处理函数不变）。
 * 全部挂在 /api/tenant/evaluation 之下，应用 TEvaluation（DEC-043：数据范围按用户 × TEvaluation 一份，缺省为空）。
 * 活动类型是字典（无组织字段）：看全部 ∪ 创建人（ev.dictionary，DEC-121），新建只认看全部（DEC-082 / DEC-356②）；
 * TEvaluation 没有向下公开，读写同一谓词，范围外读写都是 404。
 * 写入共性：If-Match 必带、Idempotency-Key 必带、ledger single；write.fields = 'body'。
 */
import { EVALUATION_OBJECTS, PERSONNEL_OBJECT } from '@italent/domain';
import { defineTable, type RoutePolicy } from '../../route-policy/index.js';
import {
  BAD_REQUEST,
  button,
  fixed,
  listScope,
  noButton,
  none,
  projector,
  NOT_FOUND,
  object,
  pointScope,
  seeAll,
  shape,
  write,
} from '../../route-policy/presets.js';

const BASE = '/api/tenant/evaluation';
const E = EVALUATION_OBJECTS;
const NF = NOT_FOUND;
/** `talent/http.uuidParam`：对象标识非 UUID → 400 VALIDATION_FAILED。 */
const byId = { invalidId: BAD_REQUEST };

type Key = 'activityType' | 'reviewGroup';

interface Spec {
  readonly path: string;
  readonly out: ReturnType<typeof shape>;
  /** 所属组织对象：按所属组织 ∪ 创建人，新建的所属组织须在范围内；成员引用人员（人员引用出口，DEC-331① / DEC-339②）。 */
  readonly owned?: true;
}

const SPECS: Readonly<Record<Key, Spec>> = {
  activityType: { path: 'activity-types', out: shape('ev.activityType') },
  reviewGroup: { path: 'review-groups', out: projector('ev.reviewGroupMembers', 'ev.reviewGroup'), owned: true },
};

/** 评审组成员的人员引用：范围内 姓名 + 工号，范围外只有姓名（不是准入，只决定响应里的附加披露）。 */
const MEMBER_REFS: RoutePolicy = object({
  object: PERSONNEL_OBJECT,
  operation: 'view',
  button: noButton('只取字段查看权'),
  scope: listScope('ev.personScope'),
  fields: fixed(['name', 'code'], 'DEC-331① / DEC-339②', PERSONNEL_OBJECT),
});
const guards = (list: readonly string[]) => (list.length ? { guards: list } : {});

const locator = (key: Key) => `ev.${key}.byId`;
const commandResult = (loc: string) => ({ generic: { targets: 'id', locator: loc } }) as const;

function evWrite(key: Key, fields: 'body' | 'none') {
  return write(fields === 'body' ? 'body' : none('删除不写字段'), 'ev.commandScope', commandResult(locator(key)), {
    ledger: 'single',
  });
}

function crud(key: Key): Record<string, RoutePolicy> {
  const spec = SPECS[key];
  const code = E[key].code;
  const path = `${BASE}/${spec.path}`;
  const base = { object: code, fields: spec.out, ...(spec.owned ? { optional: { memberRefs: MEMBER_REFS } } : {}) };
  const owned = spec.owned === true;
  // 详情 / 编辑 / 删除：范围外与不存在同一个 404（读写同一谓词）
  const point = (op: 'byId' | 'editable') => pointScope({ param: 'id' }, `ev.${key}.${op}`, NF);
  return {
    [`GET ${path}`]: object({
      ...base,
      operation: 'view',
      button: noButton('列表按对象查看权'),
      scope: listScope(owned ? 'ev.owned(ev_review_groups)' : 'ev.dictionary'),
      // 带 enabled 筛选而无 enabled 字段查看权 → 403 FILTER_FIELD_HIDDEN；排序只用可见字段（read-model.orderBy）
      guards: ['ev.filterFieldVisible'],
    }),
    [`GET ${path}/:id`]: object({
      ...base,
      ...byId,
      operation: 'view',
      button: noButton('详情按对象查看权'),
      scope: point('byId'),
    }),
    [`POST ${path}`]: object({
      ...base,
      operation: 'create',
      button: button('create', 'list'),
      // 新建：字典只认看全部；所属组织对象的所属组织须存在且在范围内（范围外与不存在同一 404，DEC-082）
      scope: owned ? pointScope({ body: 'ownerOrgId' }, 'ev.reviewGroup.ownerOrg', NF) : seeAll(NF),
      ...guards(owned ? ['ev.newPersonRefs'] : []),
      write: evWrite(key, 'body'),
    }),
    [`PATCH ${path}/:id`]: object({
      ...base,
      ...byId,
      operation: 'update',
      button: button('update', 'detail'),
      scope: point('editable'),
      ...guards(owned ? ['ev.newPersonRefs', 'ev.ownerOrgInScope'] : []),
      write: evWrite(key, 'body'),
    }),
    [`DELETE ${path}/:id`]: object({
      ...base,
      ...byId,
      operation: 'delete',
      button: button('delete', 'detail'),
      scope: point('editable'),
      write: evWrite(key, 'none'),
    }),
  };
}

export const EVALUATION_POLICIES = defineTable('evaluation', {
  // 评审组成员候选：员工信息查看权 + 人员范围（统一人员范围，分页前过滤）；字段按员工信息字段权，关键字只匹配可见字段
  [`GET ${BASE}/candidates/review-members`]: object({
    object: PERSONNEL_OBJECT,
    operation: 'view',
    button: noButton('候选按员工信息查看权'),
    scope: listScope('ev.personScope'),
    fields: projector('ev.personCandidate', 'ev.personCandidate'),
    guards: ['ev.filterFieldVisible'],
  }),
  ...crud('activityType'),
  ...crud('reviewGroup'),
});

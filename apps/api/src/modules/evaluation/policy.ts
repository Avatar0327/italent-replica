/**
 * 人才评定配置路由的现状声明（F-039；按 docs/08_设计/R3-T02-B1a_评定底座与活动类型_路由声明.md 转写，处理函数不变）。
 * 全部挂在 /api/tenant/evaluation 之下，应用 TEvaluation（DEC-043：数据范围按用户 × TEvaluation 一份，缺省为空）。
 * 活动类型是字典（无组织字段）：看全部 ∪ 创建人（ev.dictionary，DEC-121），新建只认看全部（DEC-082 / DEC-356②）；
 * TEvaluation 没有向下公开，读写同一谓词，范围外读写都是 404。
 * 写入共性：If-Match 必带、Idempotency-Key 必带、ledger single；write.fields = 'body'。
 */
import { EVALUATION_OBJECTS, PERSONNEL_OBJECT, QUALIFICATION_OBJECTS } from '@italent/domain';
import { defineTable, type RoutePolicy } from '../../route-policy/index.js';
import {
  BAD_REQUEST,
  button,
  fixed,
  listScope,
  noButton,
  noScope,
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

type Key =
  'activityType' | 'activityCycle' | 'generalScoreItem' | 'reviewGroup' | 'evaluationForm' | 'evaluationActivity';

interface Spec {
  readonly path: string;
  readonly out: ReturnType<typeof shape>;
  /** 所属组织对象：按所属组织 ∪ 创建人，新建的所属组织须在范围内；表名决定列表范围谓词的登记名。 */
  readonly owned?: {
    readonly table: string;
    readonly refGuards: readonly string[];
    readonly refs: Record<string, RoutePolicy>;
  };
  /** 照原站没有删除入口（评审组，DEC-393⑤）：不注册 DELETE 路由。 */
  readonly noDelete?: true;
  /** 新建 / 修改才有的披露分支（如活动适用范围重复提示是否带名称）。 */
  readonly optionalOnSave?: Record<string, RoutePolicy>;
  /** 不按所属组织裁剪的对象也可以带披露分支（如通用评分项停用时的引用方）。 */
  readonly optional?: Record<string, RoutePolicy>;
}

/** 评审组成员的人员引用：范围内 姓名 + 工号，范围外只有姓名（不是准入，只决定响应里的附加披露）。 */
const MEMBER_REFS: RoutePolicy = object({
  object: PERSONNEL_OBJECT,
  operation: 'view',
  button: noButton('只取字段查看权'),
  scope: listScope('ev.personScope'),
  fields: fixed(['name', 'code'], 'DEC-331① / DEC-339②', PERSONNEL_OBJECT),
});
/** 评价表评分项的引用名称：通用评分项（字典范围）与隐藏指标（只放开查看，DEC-352），都是披露分支（设计 §5.2 #6）。 */
const GENERAL_ITEM_REFS: RoutePolicy = object({
  object: E.generalScoreItem.code,
  operation: 'view',
  button: noButton('只取字段查看权'),
  scope: listScope('ev.dictionary'),
  fields: fixed(['name'], '设计 §5.2 #6', E.generalScoreItem.code),
});
const TARGET_REFS: RoutePolicy = object({
  object: QUALIFICATION_OBJECTS.target.code,
  operation: 'view',
  button: noButton('只取字段查看权'),
  scope: noScope('指标只放开查看（DEC-352），不按范围过滤'),
  fields: fixed(['name'], '设计 §5.2 #6 / DEC-352', QUALIFICATION_OBJECTS.target.code),
});

/** 通用评分项停用 / 删除时引用方评价表的可见范围（只决定提示里列哪些评价表名称，不是准入；DEC-374⑥）。 */
const FORM_REFERRERS: RoutePolicy = object({
  object: E.evaluationForm.code,
  operation: 'view',
  button: noButton('只取字段查看权与范围'),
  scope: listScope('ev.owned(ev_forms)'),
  fields: fixed(['name'], 'DEC-374⑥', E.evaluationForm.code),
});

/** 活动负责人的人员引用（同评审组成员，DEC-331① / DEC-339②）：范围内 姓名 + 工号，范围外只有姓名，是披露分支不是准入。 */
const MANAGER_REF: RoutePolicy = MEMBER_REFS;

/** 适用范围重复提示是否带冲突活动名称：只取活动“名称”字段的查看权（不是准入，命令事务内解析）。 */
const ACTIVITY_NAME_VISIBILITY: RoutePolicy = object({
  object: E.evaluationActivity.code,
  operation: 'view',
  button: noButton('只取字段查看权'),
  scope: noScope('只决定提示文字，范围由冲突活动的所属组织谓词另判'),
  fields: fixed(['name'], 'DEC-372② 🟡', E.evaluationActivity.code),
});

const SPECS: Readonly<Record<Key, Spec>> = {
  activityType: { path: 'activity-types', out: shape('ev.activityType') },
  activityCycle: { path: 'activity-cycles', out: shape('ev.activityCycle') },
  generalScoreItem: {
    path: 'general-score-items',
    out: shape('ev.generalScoreItem'),
    optional: { referrers: FORM_REFERRERS },
  },
  reviewGroup: {
    path: 'review-groups',
    out: projector('ev.reviewGroupMembers', 'ev.reviewGroup'),
    owned: { table: 'ev_review_groups', refGuards: ['ev.newPersonRefs'], refs: { memberRefs: MEMBER_REFS } },
    noDelete: true,
  },
  evaluationForm: {
    path: 'evaluation-forms',
    out: projector('ev.evaluationFormItems', 'ev.evaluationForm'),
    owned: {
      table: 'ev_forms',
      refGuards: ['ev.newFormRefs'],
      refs: { generalItemRefs: GENERAL_ITEM_REFS, targetRefs: TARGET_REFS },
    },
  },
  evaluationActivity: {
    path: 'activities',
    out: projector('ev.activityManager', 'ev.evaluationActivity'),
    owned: { table: 'ev_activities', refGuards: ['ev.newActivityRefs'], refs: { managerRef: MANAGER_REF } },
    optionalOnSave: { activityName: ACTIVITY_NAME_VISIBILITY },
  },
};

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
  const refs = spec.owned?.refs;
  const base = { object: code, fields: spec.out, ...(refs ? { optional: refs } : {}) };
  // 停用 / 删除时的披露分支（通用评分项的引用方）只挂在这两个写入口
  const onRemoval = spec.optional ? { optional: spec.optional } : {};
  // 新建 / 修改的披露分支并入共有的披露分支（base.optional）
  const onSave = spec.optionalOnSave ? { optional: { ...refs, ...spec.optionalOnSave } } : {};
  const owned = spec.owned;
  // 详情 / 编辑 / 删除：范围外与不存在同一个 404（读写同一谓词）
  const point = (op: 'byId' | 'editable') => pointScope({ param: 'id' }, `ev.${key}.${op}`, NF);
  return {
    [`GET ${path}`]: object({
      ...base,
      operation: 'view',
      button: noButton('列表按对象查看权'),
      scope: listScope(owned ? `ev.owned(${owned.table})` : 'ev.dictionary'),
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
      ...onSave,
      operation: 'create',
      button: button('create', 'list'),
      // 新建：字典只认看全部；所属组织对象的所属组织须存在且在范围内（范围外与不存在同一 404，DEC-082）
      scope: owned ? pointScope({ body: 'ownerOrgId' }, `ev.${key}.ownerOrg`, NF) : seeAll(NF),
      ...guards(owned ? owned.refGuards : []),
      write: evWrite(key, 'body'),
    }),
    [`PATCH ${path}/:id`]: object({
      ...base,
      ...onSave,
      ...onRemoval,
      ...byId,
      operation: 'update',
      button: button('update', 'detail'),
      scope: point('editable'),
      ...guards(owned ? [...owned.refGuards, 'ev.ownerOrgInScope'] : []),
      write: evWrite(key, 'body'),
    }),
    ...(spec.noDelete
      ? {}
      : {
          [`DELETE ${path}/:id`]: object({
            ...base,
            ...onRemoval,
            ...byId,
            operation: 'delete',
            button: button('delete', 'detail'),
            scope: point('editable'),
            write: evWrite(key, 'none'),
          }),
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
  ...crud('activityCycle'),
  ...crud('generalScoreItem'),
  ...crud('reviewGroup'),
  ...crud('evaluationForm'),
  ...crud('evaluationActivity'),
});

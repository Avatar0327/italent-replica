/**
 * 任职资格配置路由的现状声明（F-039；按 docs/08_设计/R3-T02-A_任职资格配置_路由声明.md 51 条转写，处理函数不变）。
 * 全部挂在 /api/tenant/qualification 之下，应用 Qualification（DEC-043：数据范围按用户 × Qualification 一份，缺省为空）。
 * 查看（DEC-352）：类别、级别、指标（含等级描述）、标准、发展通道、编码规则只要有对象 / 字段查看权就看得到全部
 * （ql.openRead），不按管理单元 / 创建人裁剪；分类、指标类型按管理单元 ∪ 向下公开（ql.readable），层级、等级方案
 * 按看全部 ∪ 创建人（ql.dictionary）。写入（新建 / 编辑 / 停用 / 删除）仍按管理单元（DEC-339① / DEC-355① / D-065）。
 * 写入共性：If-Match 必带（标准明细导入例外，逐标准在请求体带 revision）、Idempotency-Key 必带、ledger single；
 * write.fields = 'body'，确认框、引入条目与所属管理单元的选择是控制键（access.checkWriteFields）。
 */
import { MODULE_OBJECTS, QUALIFICATION_OBJECTS } from '@italent/domain';
import { defineTable, type ObjectPolicy, type RoutePolicy } from '../../route-policy/index.js';
import {
  BAD_REQUEST,
  button,
  FORBIDDEN,
  fixed,
  guardScope,
  listScope,
  noButton,
  none,
  noScope,
  NOT_FOUND,
  object,
  pointScope,
  projector,
  seeAll,
  shape,
  write,
} from '../../route-policy/presets.js';

const BASE = '/api/tenant/qualification';
const Q = QUALIFICATION_OBJECTS;
const ORG = MODULE_OBJECTS.organization.code;
const NF = NOT_FOUND;
/** `talent/http.uuidParam`：对象标识非 UUID → 400 VALIDATION_FAILED。 */
const byId = { invalidId: BAD_REQUEST };
const CONTROLS = ['confirmOverwrite', 'items', 'ownerOrgId'];

type Key = 'categoryClass' | 'category' | 'layer' | 'level' | 'targetType' | 'target' | 'gradeScheme' | 'standard';

interface Spec {
  readonly path: string;
  /** 列表的读取谓词（分页之前生效）。 */
  readonly list: string;
  /** 字典（看全部 ∪ 创建人，新建只认看全部，DEC-121）。 */
  readonly dictionary?: true;
  readonly out: ObjectPolicy['fields'];
  /** 新建 / 编辑 / 删除各自的具名守卫（被引用对象、岗职务关联、连带删除的子对象）。 */
  readonly create: readonly string[];
  readonly update: readonly string[];
  readonly remove?: readonly string[];
}

const SPECS: Readonly<Record<Key, Spec>> = {
  categoryClass: {
    path: 'category-classes',
    list: 'ql.readable(ql_category_classes)',
    out: shape('ql.categoryClass'),
    create: ['ql.referenced(categoryClass)'],
    update: [],
  },
  category: {
    path: 'categories',
    list: 'ql.openRead(ql_categories)',
    out: shape('ql.category'),
    create: ['ql.referenced(categoryClass)', 'ql.jobLinks(category)'],
    update: ['ql.jobLinks(category)', 'ql.jobLinksDerived'],
  },
  layer: { path: 'layers', list: 'ql.dictionary', dictionary: true, out: shape('ql.layer'), create: [], update: [] },
  level: {
    path: 'levels',
    list: 'ql.openRead(ql_levels)',
    out: shape('ql.level'),
    create: ['ql.referenced(layer)', 'ql.jobLinks(level)'],
    update: ['ql.referenced(layer)', 'ql.jobLinks(level)', 'ql.jobLinksDerived'],
  },
  targetType: {
    path: 'target-types',
    list: 'ql.readable(ql_target_types)',
    out: shape('ql.targetType'),
    create: ['ql.referenced(targetType)'],
    update: [],
  },
  target: {
    path: 'targets',
    list: 'ql.openRead(ql_targets)',
    out: shape('ql.target'),
    create: ['ql.referenced(targetType)', 'ql.referenced(gradeScheme)'],
    update: ['ql.referenced(gradeScheme)'],
    remove: ['ql.childDeletes(targetGradeDescription)'],
  },
  gradeScheme: {
    path: 'grade-schemes',
    list: 'ql.dictionary',
    dictionary: true,
    out: shape('ql.gradeScheme'),
    create: [],
    update: [],
    remove: ['ql.childScope(target)', 'ql.childDeletes(targetGradeDescription)'],
  },
  standard: {
    path: 'standards',
    list: 'ql.openRead(ql_standards)',
    out: projector('ql.standardNested', 'ql.standard'),
    create: ['ql.referenced(level)', 'ql.referenced(target)'],
    update: ['ql.referenced(target)'],
    remove: ['ql.childDeletes(developmentChannel)'],
  },
};

const locator = (key: Key) => `ql.${key}.byId`;
const guards = (list: readonly string[] = []) => (list.length ? { guards: list } : {});
const commandResult = (loc: string) => ({ generic: { targets: 'id', locator: loc } }) as const;

/** 标准里通用指标覆盖写入的能力标准：可选分支，未通过只省略内容（projectionHidden），不拒绝（DEC-309 #2）。 */
const OVERWRITTEN_CONTENT: RoutePolicy = object({
  object: Q.target.code,
  operation: 'view',
  button: noButton('只取字段查看权'),
  scope: listScope('ql.openRead(ql_targets)'),
  fields: fixed(['description'], 'DEC-309', Q.target.code),
});
const nested = (key: Key) => (key === 'standard' ? { optional: { overwrittenContent: OVERWRITTEN_CONTENT } } : {});

/**
 * 关联的岗职务已被别的类别 / 级别占用时，409 冲突提示带出占用对象的名称：只在操作人对本对象有查看权、名称字段可见时披露，
 * 否则用固定提示（replaceJobLinks，DEC-331④ / 第 2 轮 P2-03）。只决定提示文案，不拒绝请求；POST / PATCH / 导入共用。
 */
const conflictName = (key: 'category' | 'level') => ({
  optional: {
    conflictName: object({
      object: Q[key].code,
      operation: 'view',
      button: noButton('只取字段查看权'),
      scope: listScope(`ql.openRead(${key === 'category' ? 'ql_categories' : 'ql_levels'})`),
      fields: fixed(['name'], 'DEC-331④', Q[key].code),
    }),
  },
});
/** 会解析岗职务的写入口才带冲突名称披露分支（列表 / 详情 / 删除没有）。 */
const jobWrite = (key: Key) => (key === 'category' || key === 'level' ? conflictName(key) : {});

function qlWrite(key: Key, fields: 'body' | 'none') {
  return write(fields === 'body' ? 'body' : none('删除不写字段'), 'ql.commandScope', commandResult(locator(key)), {
    ...(fields === 'body' ? { controls: CONTROLS } : {}),
    ledger: 'single',
  });
}

/** 详情：看不到与不存在同一个 404。 */
const detailScope = (key: Key) => pointScope({ param: 'id' }, locator(key), NF);
/** 编辑 / 删除：不可见 404；看得到但不在写范围 403（QL_OUT_OF_SCOPE_READONLY / QL_PUBLIC_DOWN_READONLY）。 */
const editScope = (key: Key) => pointScope({ param: 'id' }, `ql.${key}.editable`, NF);

/** 新建范围：字典只认看全部；标准随类别的写范围；其余按授权管理单元（DEC-339，ql.ownerUnit）。 */
function createScope(key: Key): ObjectPolicy['scope'] {
  if (SPECS[key].dictionary) return seeAll(NF);
  if (key === 'standard') return pointScope({ body: 'categoryId' }, 'ql.category.editable', NF);
  return guardScope(`ql.ownerUnit(${key})`, NF);
}

function crud(key: Key): Record<string, RoutePolicy> {
  const spec = SPECS[key];
  const code = Q[key].code;
  const path = `${BASE}/${spec.path}`;
  const base = { object: code, fields: spec.out, ...nested(key) };
  return {
    [`GET ${path}`]: object({
      ...base,
      operation: 'view',
      button: noButton('列表按对象查看权'),
      scope: listScope(spec.list),
    }),
    [`GET ${path}/:id`]: object({
      ...base,
      ...byId,
      operation: 'view',
      button: noButton('详情按对象查看权'),
      scope: detailScope(key),
    }),
    [`POST ${path}`]: object({
      ...base,
      ...jobWrite(key),
      ...guards(spec.create),
      operation: 'create',
      button: button('create', 'list'),
      scope: createScope(key),
      write: qlWrite(key, 'body'),
    }),
    [`PATCH ${path}/:id`]: object({
      ...base,
      ...byId,
      ...jobWrite(key),
      ...guards(spec.update),
      operation: 'update',
      button: button('update', 'detail'),
      scope: editScope(key),
      write: qlWrite(key, 'body'),
    }),
    [`DELETE ${path}/:id`]: object({
      ...base,
      ...byId,
      ...guards(spec.remove),
      operation: 'delete',
      button: button('delete', 'detail'),
      scope: editScope(key),
      write: qlWrite(key, 'none'),
    }),
  };
}

const TARGET_DETAIL = pointScope({ param: 'id' }, 'ql.target.byId', NF);
const STANDARD_DETAIL = pointScope({ param: 'id' }, 'ql.standard.byId', NF);

/** 引入 / 导入失败时独立事务登记任务级日志（DEC-199）；归属锚点在日志事务里解析（第 3 轮 R2-07）。 */
const failureAudit = (key: 'category' | 'level' | 'standard', rows: 'items' | 'rows') => ({
  kind: 'import' as const,
  rows,
  objectType: Q[key].code,
  anchors: 'ql.importAnchors',
  resolveAnchors: 'ql.importTask',
});

function importRoute(key: 'category' | 'level'): RoutePolicy {
  return object({
    object: Q[key].code,
    operation: 'create',
    button: button('create', 'list'),
    scope: guardScope(`ql.ownerUnit(${key})`, NF),
    guards: [key === 'category' ? 'ql.referenced(categoryClass)' : 'ql.referenced(layer)', `ql.jobLinks(${key})`],
    ...conflictName(key),
    fields: shape(`ql.${key}`),
    write: write('body', 'ql.commandScope', commandResult(`ql.${key}.byId`), { controls: CONTROLS, ledger: 'single' }),
    failureAudit: failureAudit(key, 'items'),
  });
}

export const QUALIFICATION_POLICIES = defineTable('qualification', {
  ...crud('categoryClass'),
  ...crud('category'),
  ...crud('layer'),
  ...crud('level'),
  ...crud('targetType'),
  ...crud('target'),
  ...crud('gradeScheme'),
  ...crud('standard'),
  // ---- extras.ts：引入、等级描述、编码规则、标准导入、发展通道、图谱 -----------------------------------------------
  [`POST ${BASE}/categories/import`]: importRoute('category'),
  [`POST ${BASE}/levels/import`]: importRoute('level'),
  // 随指标详情；未手改的描述按等级方案的读取范围与明细字段权投影（不拒绝）
  [`GET ${BASE}/targets/:id/grade-descriptions`]: object({
    ...byId,
    object: Q.target.code,
    operation: 'view',
    button: noButton('随指标详情'),
    scope: TARGET_DETAIL,
    fields: projector('ql.gradeDescriptions', 'ql.gradeDescriptions'),
  }),
  [`PUT ${BASE}/targets/:id/grade-descriptions/:detailId`]: object({
    ...byId,
    object: Q.target.code,
    operation: 'update',
    button: button('update', 'detail'),
    scope: pointScope({ param: 'id' }, 'ql.target.editable', NF),
    fields: projector('ql.gradeDescriptions', 'ql.gradeDescriptions'),
    write: write('body', 'ql.commandScope', commandResult('ql.target.byId'), { ledger: 'single' }),
  }),
  // 编码规则：有查看权即看到全部真实规则（DEC-352）；编辑按看全部 ∪ 创建人，首次建行只认看全部（DEC-347③）
  [`GET ${BASE}/coding-rules`]: object({
    object: Q.codingRule.code,
    operation: 'view',
    button: noButton('列表按对象查看权'),
    scope: noScope('有查看权即看到全部编码规则（DEC-352）'),
    fields: shape('ql.codingRule'),
  }),
  [`PATCH ${BASE}/coding-rules/:item`]: object({
    object: Q.codingRule.code,
    operation: 'update',
    button: button('update', 'detail'),
    scope: pointScope({ param: 'item' }, 'ql.codingRule.editable', FORBIDDEN),
    fields: shape('ql.codingRule'),
    write: write('body', 'ql.commandScope', commandResult('ql.codingRule.byItem'), { ledger: 'single' }),
  }),
  // 标准明细导入：不用 If-Match，逐标准在请求体带 revision（P2-06）；类别须在写范围内，级别 / 指标按查看权解析
  [`POST ${BASE}/standards/import`]: object({
    object: Q.standard.code,
    operation: 'update',
    button: button('update', 'detail'),
    scope: listScope('ql.categoryEditable(ql_categories)'),
    fields: projector('ql.standardImportReceipt', 'ql.standardImportReceipt'),
    write: write('body', 'ql.commandScope', commandResult('ql.standard.byId'), { ledger: 'single' }),
    failureAudit: failureAudit('standard', 'rows'),
  }),
  // 目标类别 / 级别按查看人的查看权投影（不拒绝）
  [`GET ${BASE}/standards/:id/channels`]: object({
    ...byId,
    object: Q.developmentChannel.code,
    operation: 'view',
    button: noButton('随标准详情'),
    scope: STANDARD_DETAIL,
    fields: projector('ql.channels', 'ql.channels'),
  }),
  // 提示不按权限裁剪（DEC-349：用于敦促业务方与 HR 建设标准）
  [`PUT ${BASE}/standards/:id/channels`]: object({
    ...byId,
    object: Q.developmentChannel.code,
    operation: 'update',
    button: button('update', 'detail'),
    scope: pointScope({ param: 'id' }, 'ql.standard.editable', NF),
    guards: ['ql.referenced(category)', 'ql.referenced(level)'],
    fields: projector('ql.channels', 'ql.channels'),
    write: write('body', 'ql.commandScope', commandResult('ql.standard.byId'), { ledger: 'single' }),
  }),
  [`GET ${BASE}/standards/:id/chart`]: object({
    ...byId,
    object: Q.standard.code,
    operation: 'view',
    button: noButton('图谱查看'),
    scope: STANDARD_DETAIL,
    fields: projector('ql.chart', 'ql.chart'),
  }),
  // ---- candidates.ts：新建时的所属管理单元候选（DEC-339 / DEC-316②）------------------------------------------------
  [`GET ${BASE}/candidates/owner-orgs`]: object({
    object: {
      from: 'query',
      path: 'object',
      map: {
        categoryClass: Q.categoryClass.code,
        category: Q.category.code,
        level: Q.level.code,
        targetType: Q.targetType.code,
        target: Q.target.code,
      },
    },
    operation: 'create',
    button: noButton('候选按新建数据操作权'),
    scope: noScope('只返回本人在 Qualification 的授权管理单元（DEC-339），有界 200'),
    fields: projector('ql.ownerUnits', 'ql.ownerUnit'),
    optional: {
      orgFields: object({
        object: ORG,
        operation: 'view',
        button: noButton('只取字段查看权'),
        scope: listScope('org.scope'),
        fields: fixed(['code', 'name'], 'DEC-309 / DEC-316②', ORG),
      }),
    },
  }),
});

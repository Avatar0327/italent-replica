/**
 * 人才标准与指标库路由的现状声明（F-039 PR-A；按已合并的 docs/08_设计/R3-T01_人才标准_路由声明.md 35 条与
 * docs/08_设计/F-038_潜力模型图片_路由声明.md 5 条原样转写，共 40 条，处理函数不变）。
 * 全部挂在 /api/tenant/talent 之下，应用 TalentCenter（DEC-043：数据范围按 用户 × TalentCenter 一份，缺省为空）。
 * 写入共性：If-Match 必带、Idempotency-Key 必带、ledger single；write.fields = 'body'，所属管理单元的选择
 * （ownerOrgId / relationOwnerOrgId）是控制键，由 talent.ownerUnit / relationUnit 校验，不按字段编辑权拦截。
 */
import { MODULE_OBJECTS, TALENT_OBJECTS } from '@italent/domain';
import { defineTable, type ObjectPolicy, type RoutePolicy } from '../../route-policy/index.js';
import {
  all,
  any,
  BAD_REQUEST,
  button,
  fixed,
  guardScope,
  listScope,
  noButton,
  noFields,
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

const BASE = '/api/tenant/talent';
const LIB = TALENT_OBJECTS.library.code;
const CAT = TALENT_OBJECTS.dimensionCategory.code;
const TYPE = TALENT_OBJECTS.descriptionType.code;
const DIM = TALENT_OBJECTS.dimension.code;
const CCAT = TALENT_OBJECTS.criterionCategory.code;
const CRIT = TALENT_OBJECTS.criterion.code;
const ORG = MODULE_OBJECTS.organization.code;

/** `talent/http.uuidParam`：对象标识非 UUID → 400 VALIDATION_FAILED。 */
const byId = { invalidId: BAD_REQUEST };
const UNIT_CONTROLS = ['ownerOrgId', 'relationOwnerOrgId'];
/** 不存在与范围外同一个 404 响应体（文案只是“X不存在”）。 */
const NF = NOT_FOUND;

interface TalentObject {
  readonly code: string;
  readonly path: string;
  readonly locator: string;
  readonly table: string;
  readonly out: ObjectPolicy['fields'];
}
const OBJECTS = {
  library: { code: LIB, path: 'libraries', locator: 'talent.library.byId', table: 'talent_dimension_libraries' },
  dimensionCategory: {
    code: CAT,
    path: 'dimension-categories',
    locator: 'talent.dimensionCategory.byId',
    table: 'talent_dimension_categories',
  },
  descriptionType: {
    code: TYPE,
    path: 'description-types',
    locator: 'talent.descriptionType.byId',
    table: 'talent_description_types',
  },
  dimension: { code: DIM, path: 'dimensions', locator: 'talent.dimension.byId', table: 'talent_dimensions' },
  criterionCategory: {
    code: CCAT,
    path: 'criterion-categories',
    locator: 'talent.criterionCategory.byId',
    table: 'talent_criterion_categories',
  },
  criterion: { code: CRIT, path: 'criteria', locator: 'talent.criterion.byId', table: 'talent_criteria' },
} as const;
type Key = keyof typeof OBJECTS;
const OUT: Readonly<Record<Key, ObjectPolicy['fields']>> = {
  library: shape('talent.library'),
  dimensionCategory: shape('talent.dimensionCategory'),
  descriptionType: shape('talent.descriptionType'),
  dimension: shape('talent.dimension'),
  criterionCategory: shape('talent.criterionCategory'),
  criterion: projector('talent.criterionNested', 'talent.criterion'),
};
const obj = (key: Key): TalentObject => ({ ...OBJECTS[key], out: OUT[key] });

/** 标准里嵌套的指标内容：可选分支，未通过只省略内容、不拒绝（DEC-281⑪ / DEC-178）。 */
const NESTED_DIMENSION: RoutePolicy = object({
  object: DIM,
  operation: 'view',
  button: noButton('嵌套内容按对象查看权'),
  scope: listScope('talent.ownedScope(talent_dimensions)'),
  fields: fixed(['name', 'definition'], 'DEC-281⑪', DIM),
});
const nested = (key: Key) => (key === 'criterion' ? { optional: { nestedDimension: NESTED_DIMENSION } } : {});

function commandResult(locator: string) {
  return { generic: { targets: 'id', locator } } as const;
}
function talentWrite(o: TalentObject, fields: 'body' | 'none', preconditions: readonly string[] = []) {
  return write(fields === 'body' ? 'body' : none('删除不写字段'), 'talent.commandScope', commandResult(o.locator), {
    ...(fields === 'body' ? { controls: UNIT_CONTROLS } : {}),
    ...(preconditions.length ? { preconditions } : {}),
    ledger: 'single',
  });
}

/** 列表 / 详情的范围：字典（TYPE）看全部 ∪ 创建人（DEC-121）；其余按所属管理单元 + 所属人。 */
function readScope(key: Key, detail: boolean): ObjectPolicy['scope'] {
  const o = OBJECTS[key];
  if (key === 'descriptionType') {
    return detail
      ? seeAll(NF, { creatorLocator: 'talent.descriptionType.createdBy' })
      : listScope('talent.dictionaryScope');
  }
  return detail ? pointScope({ param: 'id' }, o.locator, NF) : listScope(`talent.ownedScope(${o.table})`);
}
/** 新建：字典只有看全部能新建；其余按授权管理单元（ownerUnit）及所属指标库的新建范围。 */
const CREATE_GUARDS: Readonly<Record<Key, readonly string[]>> = {
  library: ['talent.ownerUnit(library)'],
  dimensionCategory: ['talent.referenced(library)', 'talent.libraryCreatable', 'talent.ownerUnit(dimensionCategory)'],
  descriptionType: [],
  dimension: [
    'talent.referenced(library)',
    'talent.libraryCreatable',
    'talent.referenced(dimensionCategory)',
    'talent.ownerUnit(dimension)',
    'talent.descriptionTypeChoice',
  ],
  criterionCategory: ['talent.ownerUnit(criterionCategory)'],
  criterion: [
    'talent.ownerUnit(criterion)',
    'talent.referenced(criterionCategory)',
    'talent.referenced(dimension)',
    'talent.copyCategoryName',
  ],
};
const UPDATE_GUARDS: Readonly<Record<Key, readonly string[]>> = {
  library: [],
  dimensionCategory: [],
  descriptionType: [],
  dimension: ['talent.referenced(dimensionCategory)', 'talent.descriptionTypeChoice'],
  criterionCategory: [],
  criterion: [
    'talent.referenced(criterionCategory)',
    'talent.referenced(dimension)',
    'talent.copyCategoryName',
    'talent.relationUnit',
  ],
};
const guards = (list: readonly string[]) => (list.length ? { guards: list } : {});

function crud(key: Key): Record<string, RoutePolicy> {
  const o = obj(key);
  const path = `${BASE}/${o.path}`;
  const base = { object: o.code, fields: o.out, ...nested(key) };
  const writeScope =
    key === 'descriptionType'
      ? seeAll(NF, { creatorLocator: 'talent.descriptionType.createdBy' })
      : readScope(key, true);
  return {
    [`GET ${path}`]: object({
      ...base,
      operation: 'view',
      button: noButton('列表按对象查看权'),
      scope: readScope(key, false),
    }),
    [`GET ${path}/:id`]: object({
      ...base,
      ...byId,
      operation: 'view',
      button: noButton('详情按对象查看权'),
      scope: readScope(key, true),
    }),
    [`POST ${path}`]: object({
      ...base,
      ...guards(CREATE_GUARDS[key]),
      operation: 'create',
      button: button('create', 'list'),
      // 字典只有看全部能新建（DEC-082 / 121）；其余由 ownerUnit 守卫按授权管理单元判定
      // 字典只有看全部能新建（DEC-082 / 121）；其余按授权管理单元 + 新建范围（ownerUnit：NO_UNIT / UNIT_REQUIRED / NF_UNIT）
      scope: key === 'descriptionType' ? seeAll(NF) : guardScope(`talent.ownerUnit(${key})`, NF),
      write: talentWrite(o, 'body', key === 'criterion' ? ['talent.criterionDimensionRules'] : []),
    }),
    [`PATCH ${path}/:id`]: object({
      ...base,
      ...byId,
      ...guards(UPDATE_GUARDS[key]),
      operation: 'update',
      button: button('update', 'detail'),
      scope: writeScope,
      write: talentWrite(o, 'body', key === 'criterion' ? ['talent.criterionDimensionRules'] : []),
    }),
    [`DELETE ${path}/:id`]: object({
      ...base,
      ...byId,
      operation: 'delete',
      button: button('delete', 'detail'),
      scope: writeScope,
      write: talentWrite(o, 'none'),
    }),
  };
}

const OWN_UNITS = noScope('只返回本人在 TalentCenter 的授权管理单元（DEC-294③），有界 200');
const UNITS_OUT = projector('talent.ownerUnits', 'talent.ownerUnit');
const CRIT_DETAIL = pointScope({ param: 'id' }, 'talent.criterion.byId', NF);
const CRIT_VIEW: RoutePolicy = object({
  object: CRIT,
  operation: 'view',
  button: noButton('写响应随标准详情可见性'),
  scope: CRIT_DETAIL,
  fields: noFields('组合层声明出口'),
});
/** 模型图写入口：CRIT view + update + update@detail（F-038），事务内父行锁 → 当前范围 → REV。 */
function modelImageWrite(fields: 'metadata' | 'modelImage' | 'clear', out: ObjectPolicy['fields'], extra = {}) {
  return all(
    [
      object({
        object: CRIT,
        operation: 'update',
        button: button('update', 'detail'),
        scope: CRIT_DETAIL,
        fields: out,
      }),
      CRIT_VIEW,
    ],
    out,
    {
      ...byId,
      ...extra,
      write: write(
        fields === 'clear' ? none('删除模型图不写对象字段') : 'body',
        'talent.commandScope',
        commandResult('talent.criterion.byId'),
        { ledger: 'single' },
      ),
    },
  );
}

export const TALENT_POLICIES = defineTable('talent', {
  ...crud('library'),
  ...crud('dimensionCategory'),
  ...crud('descriptionType'),
  ...crud('dimension'),
  ...crud('criterionCategory'),
  ...crud('criterion'),
  // 「设置指标类别」（DEC-294⑤）：编辑数据操作权 + setDimensionCategory@detail + CRIT.dimensions 编辑权；batch atomic ≤200
  [`POST ${BASE}/criteria/:id/dimension-category`]: object({
    ...byId,
    object: CRIT,
    operation: 'update',
    button: button('setDimensionCategory', 'detail'),
    scope: CRIT_DETAIL,
    fields: OUT.criterion,
    optional: { nestedDimension: NESTED_DIMENSION },
    write: write(
      { guard: 'talent.dimensionCategoryBatch' },
      'talent.commandScope',
      commandResult('talent.criterion.byId'),
      {
        ledger: 'single',
      },
    ),
  }),
  // ---- candidates.ts：候选 --------------------------------------------------------------------------------------
  [`GET ${BASE}/candidates/dimensions`]: object({
    object: DIM,
    operation: 'view',
    button: noButton('候选按对象查看权'),
    scope: listScope('talent.ownedScope(talent_dimensions)'),
    fields: shape('talent.dimension'),
  }),
  // 字典下拉不按 TYPE 范围裁剪（DEC-281④）；只列启用；name 仅当查看人看得到 DIM.suggestions（DEC-309）
  [`GET ${BASE}/candidates/description-types`]: object({
    object: DIM,
    operation: 'view',
    button: noButton('下拉随指标编辑'),
    scope: noScope('字典下拉不按发展建议类型范围裁剪（DEC-281④）'),
    fields: projector('talent.descriptionTypeOptions', 'talent.descriptionTypeOption'),
  }),
  // object 缺失 / 域外 400；① 五对象 create；② 仅 criterion：update + update@detail + dimensions 可编辑（DEC-316③）
  [`GET ${BASE}/candidates/owner-orgs`]: any(
    [
      object({
        object: {
          from: 'query',
          path: 'object',
          map: { library: LIB, dimensionCategory: CAT, dimension: DIM, criterionCategory: CCAT, criterion: CRIT },
        },
        operation: 'create',
        button: noButton('候选按新建数据操作权'),
        scope: OWN_UNITS,
        fields: UNITS_OUT,
      }),
      object({
        object: CRIT,
        operation: 'update',
        button: button('update', 'detail'),
        scope: OWN_UNITS,
        fields: UNITS_OUT,
        guards: ['talent.criterionDimensionsEditable', 'talent.queryObjectIsCriterion'],
      }),
    ],
    {
      optional: {
        orgFields: object({
          object: ORG,
          operation: 'view',
          button: noButton('只取字段查看权'),
          scope: listScope('org.scope'),
          fields: fixed(['code', 'name'], 'DEC-309 / DEC-316②', ORG),
        }),
      },
    },
  ),
  // F-035 表单权限契约：object × operation（create / update）选择；update 时 query.id 走详情定位器
  [`GET ${BASE}/forms/:object`]: object({
    object: {
      from: 'param',
      path: 'object',
      map: {
        library: LIB,
        dimensionCategory: CAT,
        descriptionType: TYPE,
        dimension: DIM,
        criterionCategory: CCAT,
        criterion: CRIT,
      },
    },
    operation: { from: 'query', path: 'operation', map: { create: 'create', update: 'update' } },
    button: {
      from: 'query',
      path: 'operation',
      map: { create: button('create', 'list'), update: button('update', 'detail') },
    },
    scope: pointScope({ query: 'id' }, 'talent.<object>.byId', NF),
    fields: projector('talent.formAccess', 'talent.formAccess'),
    invalidId: BAD_REQUEST,
  }),
  // ---- model-image-routes.ts：潜力模型图片（F-038）------------------------------------------------------------------
  [`GET ${BASE}/criteria/:id/model-image`]: object({
    ...byId,
    object: CRIT,
    operation: 'view',
    button: noButton('随标准详情'),
    scope: CRIT_DETAIL,
    fields: projector('talent.modelImage', 'talent.modelImage'),
    // canEdit 由当前 update + update@detail 判定（只披露，不参与准入）
    optional: {
      canEdit: object({
        object: CRIT,
        operation: 'update',
        button: button('update', 'detail'),
        scope: CRIT_DETAIL,
        fields: noFields('只决定 canEdit'),
      }),
    },
  }),
  [`GET ${BASE}/criteria/:id/model-image/attachments/:attachmentId/content`]: object({
    ...byId,
    object: CRIT,
    operation: 'view',
    button: noButton('随标准详情'),
    scope: CRIT_DETAIL,
    guards: ['talent.attachmentCurrent'],
    fields: fixed(['<binary>'], 'F-038：图片二进制，contentType 白名单、nosniff、no-store'),
  }),
  [`POST ${BASE}/criteria/:id/model-image/attachments`]: modelImageWrite(
    'metadata',
    fixed(
      ['id', 'status', 'revision', 'filename', 'contentType', 'byteSize', 'sha256'],
      'F-038 图片元数据（Q-M0-126）',
    ),
  ),
  [`POST ${BASE}/criteria/:id/model-image/attachments/:attachmentId/upload`]: modelImageWrite(
    'modelImage',
    fixed(['revision', 'modelImage'], 'F-038 上传回执：当前图片元数据 / revision，不返回字节'),
    { guards: ['talent.attachmentRegistered'] },
  ),
  [`DELETE ${BASE}/criteria/:id/model-image`]: modelImageWrite(
    'clear',
    fixed(['revision', 'modelImage'], 'F-038 删图回执：modelImage = null'),
  ),
});

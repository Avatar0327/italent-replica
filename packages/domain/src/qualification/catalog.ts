/**
 * 任职资格的权限对象目录（DEC-080：真实字段与按钮；docs/02_业务建模/23 §3、§9；R3-T02 设计 §3.1、§5.1）。
 * 任职资格是独立应用 Qualification：对象只能配置进、也只在登记了该应用的身份里生效，数据范围按（用户 × 应用）
 * 存一份（DEC-043），缺省为空。
 * - 资源集合（所属管理单元）：原站只在 分类 / 类别 / 级别 / 指标类型 / 指标 / 标准 上有（StdSetID，系统字段，表单
 *   不显示、不可手选，Q-M0-132 🟢）；复刻由系统按创建人在本应用的授权管理单元填写（DEC-324②，同 DEC-294③），
 *   因此 `ownerId` / `ownerOrgId` 是系统字段。层级、等级方案、编码规则、发展通道没有。
 * - 向下公开 `publicDown`：原站没有这个字段，复刻系统的扩展（DEC-026 / DEC-324②），默认不公开、管理员可打开；
 *   只在带资源集合的对象上。标准的可见性锚在其类别上（设计 §5.1），自身不另设。
 */
import type { ButtonDefinition, ObjectDefinition } from '../permission/object-permission.js';

export const QUALIFICATION_APP = 'Qualification';

const SYSTEM_FIELDS = ['id', 'revision', 'createdBy', 'createdAt', 'updatedAt'];
const OWNER_FIELDS = ['ownerId', 'ownerOrgId'];
const crud: readonly ButtonDefinition[] = [
  { code: 'create', level: 'list', requires: 'create' },
  { code: 'update', level: 'detail', requires: 'update' },
  { code: 'delete', level: 'detail', requires: 'delete' },
];

function object(
  code: string,
  fields: readonly string[],
  system: readonly string[] = [],
  buttons: readonly ButtonDefinition[] = crud,
): ObjectDefinition {
  return {
    code: `${QUALIFICATION_APP}.${code}`,
    application: QUALIFICATION_APP,
    fields: [
      ...fields.map((field) => ({ code: field, system: false })),
      ...[...SYSTEM_FIELDS, ...system].map((field) => ({ code: field, system: true })),
    ],
    buttons,
  };
}

/** 带资源集合的对象：所属人 / 所属管理单元由系统填写，另有可编辑的向下公开开关。 */
const owned = (code: string, fields: readonly string[], system: readonly string[] = []) =>
  object(code, [...fields, 'publicDown'], [...OWNER_FIELDS, ...system]);

export const QUALIFICATION_OBJECTS = {
  /** 任职类别分类（≤5 级）：层级由上级推出（系统字段）。 */
  categoryClass: owned(
    'EmploymentCategoryClassify',
    ['code', 'name', 'parentId', 'displayOrder', 'enabled'],
    ['level'],
  ),
  /** 任职类别：引入岗职务（关联类型 + 关联对象）或新建（QL-R1）。 */
  category: owned('EmploymentCategory', ['code', 'name', 'classId', 'jobLinkType', 'jobLinks', 'enabled']),
  /** 层级：无资源集合（Q-M0-132）。 */
  layer: object('Level', ['name', 'displayOrder', 'enabled']),
  /** 任职级别：顺序号从低到高（QL-R2）。 */
  level: owned('EmploymentLevel', ['code', 'name', 'displayOrder', 'layerId', 'jobLinkType', 'jobLinks', 'enabled']),
  targetType: owned('TargetType', ['code', 'name', 'parentId', 'displayOrder', 'enabled']),
  target: owned('Target', [
    'code',
    'name',
    'typeId',
    'description',
    'isCommon',
    'evalMode',
    'gradeSchemeId',
    'displayOrder',
    'enabled',
  ]),
  /** 等级方案与等级明细（明细随方案整组编辑）：无资源集合（Q-M0-132）。 */
  gradeScheme: object('GradeScheme', ['name', 'description', 'enabled', 'details']),
  /** 指标等级描述：只存手工改过的描述（设计 §3.1），随指标授权。 */
  targetGradeDescription: object('TargetGradeDescription', ['targetId', 'gradeDetailId', 'description']),
  /** 编码规则：开通预置 4 行，只能编辑（QL-R3）。 */
  codingRule: object(
    'CodingRule',
    ['item', 'enabled', 'prefix', 'nextSeq'],
    [],
    [{ code: 'update', level: 'detail', requires: 'update' }],
  ),
  /** 任职资格标准：资源集合取自所属类别、不可改；级别范围建后不可改（QL-R18）；明细、级别描述随标准整组编辑。 */
  standard: object(
    'QualificationStandard',
    ['categoryId', 'name', 'enabled', 'levelIds', 'details', 'levelDescriptions'],
    OWNER_FIELDS,
  ),
  /** 发展通道（横向，随标准）：无资源集合（Q-M0-132）。 */
  developmentChannel: object('DevelopmentChannel', ['standardId', 'levelId', 'targetCategoryId', 'targetLevelId']),
} as const satisfies Record<string, ObjectDefinition>;

export type QualificationObject = keyof typeof QUALIFICATION_OBJECTS;

/** 带资源集合（按所属管理单元控制数据范围）的对象。 */
export const QUALIFICATION_OWNED_OBJECTS: readonly QualificationObject[] = [
  'categoryClass',
  'category',
  'level',
  'targetType',
  'target',
  'standard',
];

/**
 * 审计行带所属组织的对象：带资源集合的对象，以及随它们授权的指标等级描述（随指标）、发展通道（随标准），审计行的
 * 所属组织取锚定对象的。审计查看时只放开查看的对象（DEC-352，access.OPEN_READ）不按组织裁剪，其余按所属组织
 * 裁剪、不因向下公开放宽（设计 §8）；不在此列的为字典，只认看全部或创建人（DEC-121）。
 */
export const QUALIFICATION_ORG_AUDITED: readonly QualificationObject[] = [
  ...QUALIFICATION_OWNED_OBJECTS,
  'targetGradeDescription',
  'developmentChannel',
];

/** 审计动作前缀（`<前缀>.create|update|delete`）；审计查询的“使用用户”规则按它找创建记录。 */
export const QUALIFICATION_AUDIT_ACTIONS: Readonly<Record<QualificationObject, string>> = {
  categoryClass: 'qualification.category-class',
  category: 'qualification.category',
  layer: 'qualification.layer',
  level: 'qualification.level',
  targetType: 'qualification.target-type',
  target: 'qualification.target',
  gradeScheme: 'qualification.grade-scheme',
  targetGradeDescription: 'qualification.target-grade-description',
  codingRule: 'qualification.coding-rule',
  standard: 'qualification.standard',
  developmentChannel: 'qualification.development-channel',
};

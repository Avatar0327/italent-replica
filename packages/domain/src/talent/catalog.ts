/**
 * 人才标准的权限对象目录（DEC-080：真实字段与按钮；docs/02_业务建模/23 §2.1、§7）。
 * 人才标准是独立应用 TalentCenter（`16` §52：独立菜单组、独立配置应用、独立身份「人才标准管理员（人才标准）」），
 * 对象只能配置进、也只在登记了该应用的身份里生效。
 * DEC-281⑨：指标库、库内分类、指标、标准分类、人才标准带所属人与所属管理单元，按管理单元控制数据范围；
 * DEC-294③：所属人 / 所属管理单元由系统按创建人与其授权管理单元填写（只读，多个授权管理单元时新建可选其一）；
 * 库内分类、标准内指标关联同样按创建人 / 添加人填写，不随主对象（DEC-294 补充二）。发展建议类型是没有组织字段的字典（DEC-121 同口径）。
 */
import type { ButtonDefinition, ObjectDefinition } from '../permission/object-permission.js';

export const TALENT_APP = 'TalentCenter';
export const TALENT_DIMENSION_TYPES = ['ability', 'potential', 'experience'] as const;
export type TalentDimensionType = (typeof TALENT_DIMENSION_TYPES)[number];

/** 原站提示原文（`23` §7 #5，W-578）：编码或名称在库内重复。 */
export const TALENT_DUPLICATE_MESSAGE = '名称或者编码重复，请重新输入';
/** DEC-281②：新增能力指标引用时权重的缺省值。 */
export const TALENT_DEFAULT_WEIGHT = 1;
/**
 * DEC-281④：开通时预置的发展建议类型。原站样本只见到“行动建议”，租户可自行增改。
 * TODO(需取证 #109): 完整选项与配置入口未取到（🟡）。
 */
export const TALENT_DESCRIPTION_TYPE_PRESETS = [{ name: '行动建议', displayOrder: 1 }] as const;

const SYSTEM_FIELDS = ['id', 'revision', 'createdBy', 'createdAt', 'updatedAt'];
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
    code: `${TALENT_APP}.${code}`,
    application: TALENT_APP,
    fields: [
      ...fields.map((field) => ({ code: field, system: false })),
      ...[...SYSTEM_FIELDS, ...system].map((field) => ({ code: field, system: true })),
    ],
    buttons,
  };
}

export const TALENT_OBJECTS = {
  /** 指标库 DimensionLibrary：类型、所属管理单元建后不可修改（改类型会让已设权重的能力指标违反 TC-R3）。 */
  library: object('DimensionLibrary', ['name', 'type', 'enabled', 'displayOrder', 'ownerOrgId'], ['ownerId']),
  /** 指标库内分类 Category（DEC-281③）：类别名称 + 类别顺序，挂在库下，无编码、无层级。 */
  dimensionCategory: object('Category', ['libraryId', 'name', 'displayOrder'], ['ownerId', 'ownerOrgId']),
  /** 发展建议类型 DescriptionType（DEC-281④）：发展建议“类型”下拉的数据源，租户可配置。 */
  descriptionType: object('DescriptionType', ['name', 'enabled', 'displayOrder']),
  /**
   * 指标 Dimension：四类描述作为整组字段编辑（发展建议子表的增删改都经 suggestions）；类型取自所属指标库、
   * 分类名称是分类查找字段的显示值（只读）。编码与所属指标库建后不可改（DEC-281⑤⑥）。
   */
  dimension: object(
    'Dimension',
    [
      'libraryId',
      'code',
      'name',
      'definition',
      'categoryId',
      'displayOrder',
      'enabled',
      'grades',
      'behaviors',
      'suggestions',
      'questions',
    ],
    ['type', 'categoryName', 'ownerId', 'ownerOrgId'],
  ),
  criterionCategory: object('TalentCriterionCategory', ['name', 'displayOrder', 'ownerOrgId'], ['ownerId']),
  /**
   * 人才标准 TalentCriterion：dimensions 是对指标的引用（TC-R2），四段说明即 TalentCriterionDescription。
   * 引用行（关联记录）带自己的“指标类别”文本与所属人 / 所属管理单元（DEC-294③⑤），随 dimensions 整组授权；
   * 「设置指标类别」是详情页按钮（批量给勾选的指标填类别，要求编辑权）。
   */
  criterion: object(
    'TalentCriterion',
    [
      'categoryId',
      'name',
      'enabled',
      'abilityNote',
      'potentialNote',
      'experienceNote',
      'achievementNote',
      'dimensions',
      'ownerOrgId',
    ],
    ['ownerId'],
    [...crud, { code: 'setDimensionCategory', level: 'detail', requires: 'update' }],
  ),
} as const satisfies Record<string, ObjectDefinition>;

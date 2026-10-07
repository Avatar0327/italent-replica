/**
 * 人才标准的权限对象目录（DEC-080：真实字段与按钮；docs/02_业务建模/23 §2.1）。
 * 人才标准是独立应用 TalentCenter（`16` §52：独立菜单组、独立配置应用、独立身份「人才标准管理员（人才标准）」），
 * 对象只能配置进、也只在登记了该应用的身份里生效。四个对象都没有组织字段（数据范围按 DEC-121 口径：看全部或创建人）。
 */
import type { ButtonDefinition, ObjectDefinition } from '../permission/object-permission.js';

export const TALENT_APP = 'TalentCenter';
export const TALENT_DIMENSION_TYPES = ['ability', 'potential', 'experience'] as const;
export type TalentDimensionType = (typeof TALENT_DIMENSION_TYPES)[number];

const SYSTEM_FIELDS = ['id', 'revision', 'createdBy', 'createdAt', 'updatedAt'];
const crud: readonly ButtonDefinition[] = [
  { code: 'create', level: 'list', requires: 'create' },
  { code: 'update', level: 'detail', requires: 'update' },
  { code: 'delete', level: 'detail', requires: 'delete' },
];

function object(code: string, fields: readonly string[], system: readonly string[] = []): ObjectDefinition {
  return {
    code: `${TALENT_APP}.${code}`,
    application: TALENT_APP,
    fields: [
      ...fields.map((field) => ({ code: field, system: false })),
      ...[...SYSTEM_FIELDS, ...system].map((field) => ({ code: field, system: true })),
    ],
    buttons: crud,
  };
}

export const TALENT_OBJECTS = {
  /** 指标库 DimensionLibrary：类型创建后不可修改（改类型会让已设权重的能力指标违反 TC-R3）。 */
  library: object('DimensionLibrary', ['name', 'type', 'enabled', 'displayOrder']),
  /** 指标 Dimension：四类描述作为整组字段编辑；类型、指标库状态取自所属指标库（只读）。 */
  dimension: object(
    'Dimension',
    [
      'libraryId',
      'code',
      'name',
      'definition',
      'category',
      'displayOrder',
      'enabled',
      'grades',
      'behaviors',
      'suggestions',
      'questions',
    ],
    ['type', 'libraryName', 'libraryEnabled'],
  ),
  criterionCategory: object('TalentCriterionCategory', ['name', 'displayOrder']),
  /** 人才标准 TalentCriterion：dimensions 是对指标的引用（TC-R2），四段说明即 TalentCriterionDescription。 */
  criterion: object('TalentCriterion', [
    'categoryId',
    'name',
    'enabled',
    'abilityNote',
    'potentialNote',
    'experienceNote',
    'achievementNote',
    'dimensions',
  ]),
} as const satisfies Record<string, ObjectDefinition>;

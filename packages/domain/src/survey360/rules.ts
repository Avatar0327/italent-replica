/**
 * 360 度评估的数量上限（docs/02_业务建模/25 §3；DEC-033）。纯常量，无 IO。
 */

export const SURVEY360_LIMITS = {
  /** DEC-033：租户评价角色上限（含内置）。 */
  tenantRoles: 90,
  /** E3-R4 / DEC-033：单套卷最多 15 个角色（含自评）。 */
  rolesPerQuestionnaire: 15,
  /** E3-R6：选项最多 15 个。 */
  optionsPerScale: 15,
  /** E3-R3：一个评价对象 1–3 个套卷。 */
  questionnairesPerObject: 3,
  /** E3-R16：一个活动最多 30,000 个评价对象。 */
  objectsPerActivity: 30_000,
  /** E3-R17：一个评价对象最多 500 个评价者；一个活动最多 50,000 个评价者（按评价关系计）。 */
  appraisersPerObject: 500,
  appraisersPerActivity: 50_000,
  /** 批量导入单次上限（AGENTS.md §10「批量」）。 */
  importRows: 2_000,
} as const;

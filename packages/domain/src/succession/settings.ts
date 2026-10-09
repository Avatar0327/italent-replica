/**
 * 继任管理的租户开关（R3-T05 设计 §1.5）：走现有两层配置（system_settings + 租户覆盖，REQ-TEN-001 R3），
 * 系统值随迁移种子下发；写协议沿用 PUT /api/tenant/settings/:key。每个键在这里给出默认值与取值校验，
 * 写入时由 tenant-settings 的校验登记位拒绝非法值（400 SETTING_VALUE_INVALID），读取方不再兜底猜测。
 */
export const SUCCESSION_SYNC_STRATEGIES = ['append', 'overwrite', 'overwrite_in_scope'] as const;
export type SuccessionSyncStrategy = (typeof SUCCESSION_SYNC_STRATEGIES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

interface SettingSpec<T> {
  readonly description: string;
  readonly defaultValue: T;
  /** 租户覆盖值是否合法（系统值 null 只表示“未配置”，租户不能写 null，见 tenant-settings 路由）。 */
  readonly valid: (value: unknown) => boolean;
}

export const SUCCESSION_SETTINGS = {
  /** SC-R7：查看人本人作为负责人 / 现任时，能否看到自己的继任者（§5.5、§8.4）。 */
  'succession.self_successors_visible': {
    description: '继任：本人作为负责人 / 现任时可见自己的继任者',
    defaultValue: true,
    valid: (value) => typeof value === 'boolean',
  } satisfies SettingSpec<boolean>,
  /** 盘点 → 继任同步策略（§5.7；租户当前为追加）。 */
  'succession.sync_strategy': {
    description: '继任：盘点同步策略（append / overwrite / overwrite_in_scope）',
    defaultValue: 'append' as SuccessionSyncStrategy,
    valid: (value) => SUCCESSION_SYNC_STRATEGIES.includes(value as SuccessionSyncStrategy),
  } satisfies SettingSpec<SuccessionSyncStrategy>,
  /** 兼岗人员是否参与职位风险计算（`27` §8；与卡片“显示现任人员”分开）。 */
  'succession.part_time_in_risk_calc': {
    description: '继任：兼岗人员参与职位风险计算',
    defaultValue: false,
    valid: (value) => typeof value === 'boolean',
  } satisfies SettingSpec<boolean>,
  /** 组织继任地图默认层数（§5.5，2～4）。 */
  'succession.map_default_depth': {
    description: '继任：组织继任地图默认层数（2～4）',
    defaultValue: 3,
    valid: (value) => isInteger(value, 2, 4),
  } satisfies SettingSpec<number>,
  /** 组织关联信息定时统计间隔（小时，§4.6 槽键）。 */
  'succession.org_stats_interval_hours': {
    description: '继任：组织关联信息统计间隔（小时，1～24）',
    defaultValue: 4,
    valid: (value) => isInteger(value, 1, 24),
  } satisfies SettingSpec<number>,
  /**
   * 继任侧系统主体（§4.0，D-04 / DEC-311）：同步与本模块 run 的目标写入主体与所属人。系统值 null = 未配置，
   * 执行时按主体不可用失败（PRINCIPAL_UNAVAILABLE），不回退到任何人；租户覆盖只接受小写 UUID（DEC-194）。
   */
  'succession.system_principal_user_id': {
    description: '继任：继任侧系统主体（用户 ID，未配置时同步与计算不执行）',
    defaultValue: null,
    valid: (value) => typeof value === 'string' && UUID.test(value),
  } satisfies SettingSpec<string | null>,
} as const;

export type SuccessionSettingKey = keyof typeof SUCCESSION_SETTINGS;
export const SUCCESSION_SETTING_KEYS = Object.keys(SUCCESSION_SETTINGS) as SuccessionSettingKey[];

export function isSuccessionSettingKey(key: string): key is SuccessionSettingKey {
  return Object.hasOwn(SUCCESSION_SETTINGS, key);
}

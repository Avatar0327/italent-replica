/**
 * 任职资格子集的两个系统预置开关（R3-T02 C1-1，设计 §4.3 / §4.5；规格 23 §10 SW73 / SW74）：走现有两层配置
 * （system_settings 全局行 + 租户覆盖，REQ-TEN-001 R3），系统值随迁移种子下发，写协议沿用 PUT /api/tenant/settings/:key；
 * 不进种子补装登记表（DEC-361：全局行，迁移写入即对全部租户生效）。键、默认值与说明与迁移种子一致，由 AC-QL-subset 核对。
 * 默认值照原站租户实测：SW73 关、SW74 开（docs/05_验收/02_原站写入测试结果.md、W-677 / W-678）。
 */
export interface QualificationSettingSpec {
  readonly description: string;
  readonly defaultValue: boolean;
  /** 设置页上的提示（P-2 ①）；文案进资源文件时以此为准（DEC-045）。 */
  readonly hint?: string;
  /** 租户覆盖值是否合法。 */
  readonly valid: (value: unknown) => boolean;
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

export type QualificationSettingKey = 'qualification.sync_enabled' | 'qualification.auto_sync_editable';

export const QUALIFICATION_SETTINGS: Readonly<Record<QualificationSettingKey, QualificationSettingSpec>> = {
  /** SW73：员工岗职位信息变动同步生成任职资格子集（C1-4 消费者读取；关闭 → 处理器 skipped）。 */
  'qualification.sync_enabled': {
    description: '任职资格：员工岗职位信息变动同步生成任职资格子集（SW73）',
    defaultValue: false,
    hint: '关闭后所有任职变更都不再同步任职资格',
    valid: isBoolean,
  },
  /** SW74：自动同步的子集数据允许手动修改或删除（追溯：按行的 is_auto_sync 实时判断，DEC-331③）。 */
  'qualification.auto_sync_editable': {
    description: '任职资格：自动同步的子集数据允许手动修改或删除（SW74）',
    defaultValue: true,
    valid: isBoolean,
  },
};

export const QUALIFICATION_SETTING_KEYS = Object.keys(QUALIFICATION_SETTINGS) as QualificationSettingKey[];

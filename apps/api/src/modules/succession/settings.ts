/**
 * 继任租户开关的写入校验（R3-T05 设计 §1.5）：键、默认值与合法取值在领域层（SUCCESSION_SETTINGS），系统值随迁移种子
 * 下发；这里把校验登记给两层配置的写入口，非法值 400 SETTING_VALUE_INVALID，读取方拿到的一定是合法值或系统值。
 */
import { SUCCESSION_SETTING_KEYS, SUCCESSION_SETTINGS } from '@italent/domain';
import { registerSettingValidator } from '../tenant-settings/service.js';

for (const key of SUCCESSION_SETTING_KEYS) registerSettingValidator(key, SUCCESSION_SETTINGS[key].valid);

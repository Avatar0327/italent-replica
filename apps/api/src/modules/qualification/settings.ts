/**
 * 任职资格 SW73 / SW74 开关的写入校验（R3-T02 C1-1）：键、默认值与合法取值在领域层（QUALIFICATION_SETTINGS），系统值随
 * 迁移种子下发；这里把校验登记给两层配置的写入口，非法值 400 SETTING_VALUE_INVALID，读取方拿到的一定是布尔值。
 */
import { QUALIFICATION_SETTING_KEYS, QUALIFICATION_SETTINGS } from '@italent/domain';
import { registerSettingValidator } from '../tenant-settings/service.js';

for (const key of QUALIFICATION_SETTING_KEYS) registerSettingValidator(key, QUALIFICATION_SETTINGS[key].valid);

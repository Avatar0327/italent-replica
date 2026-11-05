// F-419：两层配置的真实信封，由 AC-FE-F419-contract 用 HTTP 响应逐键核对；不依赖 Playwright。
import { EXIT_TERMINATION_PRESET, EXIT_TERMINATION_SETTING_KEY } from '@italent/domain';

export const terminationDefault = {
  key: EXIT_TERMINATION_SETTING_KEY,
  value: { ...EXIT_TERMINATION_PRESET } as Record<string, boolean>,
  source: 'system' as 'system' | 'tenant',
  revision: 0,
  systemVersion: 1,
  overridable: true,
};
export const terminationRejected = {
  error: {
    code: 'VALIDATION_FAILED',
    message: '配置值不合法',
    details: { reason: 'SETTING_VALUE_INVALID', key: EXIT_TERMINATION_SETTING_KEY },
  },
};

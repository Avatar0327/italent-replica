/** 迁移里的 CHECK 枚举与领域常量必须一致（drizzle-kit 无法解析工作区源码，schema 中只能重复字面量）。 */
import { ADMIN_ROLE_VALUES, BUTTON_LEVEL_VALUES } from '@italent/db';
import { ADMIN_ROLES, BUTTON_LEVELS } from '@italent/domain';
import { describe, expect, it } from 'vitest';

describe('权限表 CHECK 枚举与领域常量同步', () => {
  it('管理员身份与按钮级别', () => {
    expect([...ADMIN_ROLE_VALUES]).toEqual([...ADMIN_ROLES]);
    expect([...BUTTON_LEVEL_VALUES]).toEqual([...BUTTON_LEVELS]);
  });
});

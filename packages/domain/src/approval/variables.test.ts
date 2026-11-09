import { describe, expect, it } from 'vitest';
import {
  MATRIX_LIMITS,
  VARIABLE_STATUSES,
  VARIABLE_USAGE_SCOPES,
  initialVariableStatus,
  statusAfter,
  usageScopesViolation,
} from './variables.js';

describe('状态机（设计 §2.5，三类对象相同，无删除）', () => {
  it('新建可选草稿或直接启用', () => {
    expect(initialVariableStatus(false)).toBe('draft');
    expect(initialVariableStatus(true)).toBe('enabled');
    expect([...VARIABLE_STATUSES]).toEqual(['draft', 'enabled', 'disabled']);
  });

  it('草稿 →启用→ 启用 →停用→ 停用 →启用→ 启用', () => {
    expect(statusAfter('draft', 'enable')).toBe('enabled');
    expect(statusAfter('enabled', 'disable')).toBe('disabled');
    expect(statusAfter('disabled', 'enable')).toBe('enabled');
  });

  it('草稿不能直接停用；停用不能回草稿；重复启用 / 停用不合法', () => {
    expect(statusAfter('draft', 'disable')).toBeNull();
    expect(statusAfter('enabled', 'enable')).toBeNull();
    expect(statusAfter('disabled', 'disable')).toBeNull();
  });
});

describe('公共变量适用范围', () => {
  it('三项的非空子集，去重后合法；空 / 未知项 / 重复项不合法', () => {
    expect([...VARIABLE_USAGE_SCOPES]).toEqual(['process', 'business_rule', 'message_template']);
    expect(usageScopesViolation(['process'])).toBeNull();
    expect(usageScopesViolation(['process', 'business_rule', 'message_template'])).toBeNull();
    expect(usageScopesViolation([])).not.toBeNull();
    expect(usageScopesViolation(['other'])).not.toBeNull();
    expect(usageScopesViolation(['process', 'process'])).not.toBeNull();
  });
});

describe('矩阵结构上限（设计 §2.1 规模上限）', () => {
  it('常量取值', () => {
    expect(MATRIX_LIMITS).toEqual({
      conditionColumns: 5,
      roleColumns: 10,
      rows: 500,
      conditionCellIds: 50,
      roleCellIds: 100,
      totalCellIds: 20000,
    });
  });
});

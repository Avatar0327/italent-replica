/**
 * AC-APV-F326-02（F-326 S1 纯函数部分，设计 §2.2 / §2.3 / §7）：编码前缀固定，两类变量规则分开；
 * 客户端自带前缀报错；应用变量后缀 2 / 19 / ee 成功，公共变量后缀 2x 失败、HTCtoTind0 成功；两类后缀含 - 失败。
 * 接口部分（400 与入库）由 S2 补。
 */
import {
  APPLICATION_VARIABLE_PREFIX,
  PUBLIC_VARIABLE_PREFIX,
  VARIABLE_DATA_TYPES,
  defaultValueViolation,
  matrixCodeViolation,
  variableCodeOf,
  variableCodeViolation,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';

describe('编码前缀（系统固定）', () => {
  it('前缀常量', () => {
    expect(PUBLIC_VARIABLE_PREFIX).toBe('Global.B.');
    expect(APPLICATION_VARIABLE_PREFIX).toBe('B.');
  });

  it('应用变量：后缀 2、19、ee 成功，存为 B.2 / B.19 / B.ee（可数字开头、可纯数字）', () => {
    for (const suffix of ['2', '19', 'ee']) {
      expect(variableCodeViolation('application', suffix)).toBeNull();
      expect(variableCodeOf('application', suffix)).toBe(`B.${suffix}`);
    }
    expect(variableCodeViolation('application', 'a_B9')).toBeNull();
    expect(variableCodeViolation('application', 'a'.repeat(64))).toBeNull();
  });

  it('公共变量：HTCtoTind0 成功存为 Global.B.HTCtoTind0；数字开头 2x 失败（字母开头）', () => {
    expect(variableCodeViolation('public', 'HTCtoTind0')).toBeNull();
    expect(variableCodeOf('public', 'HTCtoTind0')).toBe('Global.B.HTCtoTind0');
    expect(variableCodeViolation('public', '2x')).toBe('CODE_SUFFIX_INVALID');
    expect(variableCodeViolation('public', '2')).toBe('CODE_SUFFIX_INVALID');
    expect(variableCodeViolation('public', 'a'.repeat(64))).toBeNull();
  });

  it('两类后缀含 - 失败；空、超长、中文、点号、空白失败', () => {
    for (const scope of ['public', 'application'] as const) {
      for (const suffix of ['a-b', '', 'a'.repeat(65), '编码', 'a.b', 'a b', ' a', 'a\n']) {
        expect(variableCodeViolation(scope, suffix), `${scope}:${JSON.stringify(suffix)}`).not.toBeNull();
      }
    }
  });

  it('客户端自带前缀报错（reason = CODE_PREFIX_PROVIDED），不会被悄悄剥掉或重复拼接', () => {
    expect(variableCodeViolation('public', 'Global.B.abc')).toBe('CODE_PREFIX_PROVIDED');
    expect(variableCodeViolation('application', 'B.abc')).toBe('CODE_PREFIX_PROVIDED');
    // 应用变量后缀不能以公共前缀起头；公共变量后缀也不能带应用前缀
    expect(variableCodeViolation('application', 'Global.B.abc')).toBe('CODE_PREFIX_PROVIDED');
    expect(variableCodeViolation('public', 'B.abc')).toBe('CODE_PREFIX_PROVIDED');
    // 不带点号的字母 B 开头是合法后缀，不算自带前缀
    expect(variableCodeViolation('application', 'Bxyz')).toBeNull();
    expect(variableCodeViolation('public', 'Bxyz')).toBeNull();
  });

  it('两套规则分开：同一后缀在两类里结果不同', () => {
    expect(variableCodeViolation('application', '2x')).toBeNull();
    expect(variableCodeViolation('public', '2x')).not.toBeNull();
  });

  it('矩阵编码：不加前缀，^[A-Za-z0-9_]{1,64}$', () => {
    for (const code of ['M1', '2', 'a_b', 'a'.repeat(64)]) expect(matrixCodeViolation(code), code).toBeNull();
    for (const code of ['', 'a-b', 'a.b', 'a'.repeat(65), '矩阵', ' a']) {
      expect(matrixCodeViolation(code), JSON.stringify(code)).not.toBeNull();
    }
  });
});

describe('默认值校验（设计 §2.3，纯形态；存在性与在职由 S2 读库复核）', () => {
  const UUID_A = '11111111-1111-4111-8111-111111111111';
  const UUID_B = '22222222-2222-4222-8222-222222222222';

  it('七种数据类型', () => {
    expect([...VARIABLE_DATA_TYPES]).toEqual([
      'string',
      'integer',
      'decimal',
      'datetime',
      'boolean',
      'person',
      'persons',
    ]);
  });

  it('空值（null / 未给）对所有类型都不违规（人员类启用时才要求非空，属状态机 / S2）', () => {
    for (const type of VARIABLE_DATA_TYPES) expect(defaultValueViolation(type, null), type).toBeNull();
  });

  it('string：≤1000 码元、多行；整数：安全整数；布尔：true / false', () => {
    expect(defaultValueViolation('string', '说明\n第二行\t缩进')).toBeNull();
    expect(defaultValueViolation('string', 'a'.repeat(1000))).toBeNull();
    expect(defaultValueViolation('string', 'a'.repeat(1001))).toBe('TEXT_TOO_LONG');
    expect(defaultValueViolation('string', 'x\uD800')).toBe('TEXT_MALFORMED');
    expect(defaultValueViolation('string', 'x\u0001')).toBe('TEXT_CONTROL_CHAR');
    expect(defaultValueViolation('string', 5)).toBe('DEFAULT_VALUE_TYPE');
    expect(defaultValueViolation('integer', 42)).toBeNull();
    expect(defaultValueViolation('integer', -7)).toBeNull();
    for (const bad of [1.5, '1', Number.MAX_SAFE_INTEGER + 1, Number.NaN, true]) {
      expect(defaultValueViolation('integer', bad), String(bad)).toBe('DEFAULT_VALUE_TYPE');
    }
    expect(defaultValueViolation('boolean', false)).toBeNull();
    expect(defaultValueViolation('boolean', 'true')).toBe('DEFAULT_VALUE_TYPE');
  });

  it('小数：十进制字符串，≤18 位有效数字', () => {
    for (const ok of ['0', '-1.50', '123456789012345678', '0.123456789012345678', '1000.5']) {
      expect(defaultValueViolation('decimal', ok), ok).toBeNull();
    }
    for (const bad of ['1e5', '1.', '.5', 'abc', '', '1234567890123456789', '0.1234567890123456789', 1.5]) {
      expect(defaultValueViolation('decimal', bad), String(bad)).toBe('DEFAULT_VALUE_TYPE');
    }
  });

  it('时间：ISO 日期时间（含时区偏移或 Z）', () => {
    expect(defaultValueViolation('datetime', '2026-11-01T08:30:00+08:00')).toBeNull();
    expect(defaultValueViolation('datetime', '2026-11-01T00:30:00.000Z')).toBeNull();
    for (const bad of ['2026-11-01', '2026-13-01T00:00:00Z', 'yesterday', 20261101]) {
      expect(defaultValueViolation('datetime', bad), String(bad)).toBe('DEFAULT_VALUE_TYPE');
    }
  });

  it('时间：不存在的日历日期一律拒绝（不能靠 Date.parse 归一到别的日子），闰日与时区偏移正例通过', () => {
    for (const bad of [
      '2026-02-30T00:00:00Z',
      '2026-02-29T00:00:00Z', // 2026 不是闰年
      '2026-04-31T12:00:00+08:00',
      '2100-02-29T00:00:00Z', // 世纪年非 400 倍数
      '2026-00-10T00:00:00Z',
      '2026-01-00T00:00:00Z',
      '2026-01-32T00:00:00Z',
      '2026-11-01T24:00:00Z',
      '2026-11-01T23:60:00Z',
      '2026-11-01T23:59:60Z',
      '2026-11-01T08:30:00+24:00',
      '2026-11-01T08:30:00+08:60',
    ]) {
      expect(defaultValueViolation('datetime', bad), bad).toBe('DEFAULT_VALUE_TYPE');
    }
    for (const ok of [
      '2028-02-29T00:00:00Z', // 闰日
      '2000-02-29T23:59:59Z', // 400 倍数的世纪年
      '2026-02-28T23:59:59-05:00',
      '2026-04-30T08:30:00+08:00',
      '2026-12-31T00:00:00.123+14:00',
      '2026-01-31T00:00Z',
    ]) {
      expect(defaultValueViolation('datetime', ok), ok).toBeNull();
    }
  });

  it('人员：1 个 UUID；多人：1～100 个 UUID 且去重', () => {
    expect(defaultValueViolation('person', UUID_A)).toBeNull();
    expect(defaultValueViolation('person', 'not-a-uuid')).toBe('DEFAULT_VALUE_TYPE');
    expect(defaultValueViolation('person', [UUID_A])).toBe('DEFAULT_VALUE_TYPE');
    expect(defaultValueViolation('persons', [UUID_A, UUID_B])).toBeNull();
    expect(defaultValueViolation('persons', [])).toBe('DEFAULT_VALUE_TYPE');
    expect(defaultValueViolation('persons', [UUID_A, UUID_A])).toBe('DEFAULT_VALUE_TYPE');
    expect(defaultValueViolation('persons', UUID_A)).toBe('DEFAULT_VALUE_TYPE');
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(defaultValueViolation('persons', many(100))).toBeNull();
    expect(defaultValueViolation('persons', many(101))).toBe('DEFAULT_VALUE_TYPE');
  });
});

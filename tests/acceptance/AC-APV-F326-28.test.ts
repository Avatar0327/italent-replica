/**
 * AC-APV-F326-28 ①（F-326 S1 纯函数部分，设计 §2.1「文本字段统一校验」/ §7）：
 * 对设计表里每个文本字段，未配对代理码元（高 / 低 / 颠倒；开头 / 中间 / 结尾）→ TEXT_MALFORMED；
 * 配对表情通过且计 2 码元；单行含 \t → TEXT_CONTROL_CHAR；多行放行 \t \n \r、拒绝 \u0001。
 * ②真实 HTTP 小请求由 S2 / S3 补，③最大合法描述新建成功由 S2 补。
 */
import { VARIABLE_TEXT_FIELDS, textViolation } from '@italent/domain';
import { describe, expect, it } from 'vitest';

describe('文本字段表（设计 §2.1）', () => {
  it('上限与单 / 多行', () => {
    expect(VARIABLE_TEXT_FIELDS).toEqual({
      variableName: { max: 100, multiline: false },
      matrixName: { max: 100, multiline: false },
      matrixColumnName: { max: 50, multiline: false },
      matrixDescription: { max: 255, multiline: true },
      variableDescription: { max: 32766, multiline: true },
      stringDefaultValue: { max: 1000, multiline: true },
    });
  });
});

const FIELDS = Object.entries(VARIABLE_TEXT_FIELDS);
const LONE = { 高代理: '\uD800', 低代理: '\uDC00', 低高颠倒: '\uDC00\uD800' } as const;

describe.each(FIELDS)('%s', (_name, opts) => {
  it.each(Object.entries(LONE))('%s 在开头 / 中间 / 结尾 → TEXT_MALFORMED', (_label, bad) => {
    for (const value of [`${bad}说明`, `前${bad}后`, `说明${bad}`, bad]) {
      expect(textViolation(value, opts), JSON.stringify(value)).toBe('TEXT_MALFORMED');
    }
  });

  it('配对表情通过', () => {
    expect(textViolation('说明😀', opts)).toBeNull();
    expect(textViolation('😀', opts)).toBeNull();
    expect(textViolation('a😀b', opts)).toBeNull();
  });

  it('配对代理计 2 码元：恰好顶满上限通过，多一个码元 TEXT_TOO_LONG', () => {
    const full = '中'.repeat(opts.max - 2) + '😀';
    expect(full.length).toBe(opts.max);
    expect(textViolation(full, opts)).toBeNull();
    expect(textViolation('中'.repeat(opts.max - 1) + '😀', opts)).toBe('TEXT_TOO_LONG');
    expect(textViolation('中'.repeat(opts.max + 1), opts)).toBe('TEXT_TOO_LONG');
  });

  it('控制字符：C0 与 DEL 拒绝，普通标点与中文通过', () => {
    expect(textViolation('甲 乙，丙。', opts)).toBeNull();
    for (const bad of ['\u0001', '\u0000', '\u001F', '\u007F']) {
      expect(textViolation(`x${bad}y`, opts), JSON.stringify(bad)).toBe('TEXT_CONTROL_CHAR');
    }
  });
});

describe('单行 / 多行', () => {
  it('单行字段含 \\t \\n \\r → TEXT_CONTROL_CHAR', () => {
    for (const field of ['variableName', 'matrixName', 'matrixColumnName'] as const) {
      for (const ws of ['\t', '\n', '\r']) {
        expect(textViolation(`甲${ws}乙`, VARIABLE_TEXT_FIELDS[field]), `${field}:${JSON.stringify(ws)}`).toBe(
          'TEXT_CONTROL_CHAR',
        );
      }
    }
  });

  it('多行字段放行 \\t \\n \\r，拒绝 \\u0001', () => {
    for (const field of ['matrixDescription', 'variableDescription', 'stringDefaultValue'] as const) {
      const opts = VARIABLE_TEXT_FIELDS[field];
      expect(textViolation('甲\t乙\n丙\r\n丁', opts), field).toBeNull();
      expect(textViolation('甲\u0001乙', opts), field).toBe('TEXT_CONTROL_CHAR');
    }
  });
});

describe('判定顺序与边界', () => {
  it('良构先于控制字符先于长度', () => {
    const opts = { max: 3, multiline: false };
    expect(textViolation('\uD800\u0001abcdef', opts)).toBe('TEXT_MALFORMED');
    expect(textViolation('\u0001abcdef', opts)).toBe('TEXT_CONTROL_CHAR');
    expect(textViolation('abcdef', opts)).toBe('TEXT_TOO_LONG');
  });

  it('32765 个中文字 + 1 个配对代理 = 32767 码元 → 超长；32766 个中文字恰好通过', () => {
    const opts = VARIABLE_TEXT_FIELDS.variableDescription;
    expect(textViolation('中'.repeat(32765) + '😀', opts)).toBe('TEXT_TOO_LONG');
    expect(textViolation('中'.repeat(32766), opts)).toBeNull();
  });

  it('空串长度合法（名称类先去首尾空白再判非空，属字段规则，由 S2 / S3 接口层调用前处理）', () => {
    expect(textViolation('', { max: 10, multiline: false })).toBeNull();
    expect(textViolation(' 甲 ', { max: 3, multiline: false })).toBeNull();
  });
});

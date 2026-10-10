/**
 * F-082（F082-1）：存储模式词法 / 语法——句柄 `@{tr-field:<uuid>}` 与占位符 `〔不可见字段〕`（契约 §1.2）。
 * 输入模式下 `@` 仍是非法字符；字符串字面量里的 `@{…}`、占位符都是普通文本。
 */
import { describe, expect, it } from 'vitest';
import {
  checkInputLimits,
  fieldHandle,
  formulaFieldIds,
  HIDDEN_FIELD_PLACEHOLDER,
  parseFieldHandle,
  parseStoredFormula,
  tokenize,
  validateFormula,
} from './index.js';
import { parseFormula } from './parser.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const HANDLE_A = `@{tr-field:${ID_A}}`;
const HANDLE_B = `@{tr-field:${ID_B}}`;
const UPPER = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

describe('句柄的生成与识别', () => {
  it('fieldHandle 生成小写 UUID 句柄；parseFieldHandle 只认完整、小写的句柄', () => {
    expect(fieldHandle(UPPER)).toBe(`@{tr-field:${UPPER.toLowerCase()}}`);
    expect(parseFieldHandle(HANDLE_A)).toBe(ID_A);
    expect(parseFieldHandle(`${HANDLE_A} `)).toBeUndefined();
    expect(parseFieldHandle('@{tr-field:not-a-uuid}')).toBeUndefined();
    expect(parseFieldHandle('@{other:' + ID_A + '}')).toBeUndefined();
    expect(parseFieldHandle(`@{tr-field:${UPPER}}`)).toBeUndefined();
  });

  it('fieldHandle 拒绝非 UUID，避免拼出可注入的句柄', () => {
    expect(() => fieldHandle('x}+@{tr-field:y')).toThrow();
  });
});

describe('词法：存储模式识别句柄，输入模式不认', () => {
  it('存储模式：句柄是一个 handle 词，值为字段 ID', () => {
    const tokens = tokenize(`${HANDLE_A} + 1`, { handles: true });
    expect(tokens.map((token) => `${token.kind}:${token.text}`)).toEqual([
      `handle:${HANDLE_A}`,
      'operator:+',
      'number:1',
      'eof:',
    ]);
    expect(tokens[0]!.value).toBe(ID_A);
  });

  it('输入模式：@ 是无法识别的字符（用户无法提交句柄）', () => {
    expect(() => tokenize(`${HANDLE_A} + 1`)).toThrow(/无法识别的字符/);
    const parsed = parseFormula(`${HANDLE_A} + 1`);
    expect(parsed.ok).toBe(false);
  });

  it('存储模式也不接受大写 UUID、残缺句柄', () => {
    expect(() => tokenize(`@{tr-field:${UPPER}}`, { handles: true })).toThrow();
    expect(() => tokenize('@{tr-field:abc}', { handles: true })).toThrow();
    expect(() => tokenize('@{tr-field:', { handles: true })).toThrow();
  });

  it('字符串字面量里的句柄原文、占位符都是普通文本', () => {
    const source = `"${HANDLE_A}" + "${HIDDEN_FIELD_PLACEHOLDER}"`;
    for (const handles of [true, false]) {
      const kinds = tokenize(source, { handles }).map((token) => token.kind);
      expect(kinds).toEqual(['string', 'operator', 'string', 'eof']);
    }
  });

  it('占位符是专用词：F-082 路径（placeholders:true）的输入模式词法不报非法字符', () => {
    const kinds = tokenize(`盘点对象.${HIDDEN_FIELD_PLACEHOLDER}`, { placeholders: true }).map((token) => token.kind);
    expect(kinds).toEqual(['identifier', 'dot', 'placeholder', 'eof']);
  });

  it('默认不识别占位符：B5 路径（开关关闭）逐字不变，仍报无法识别的字符（F-082 P3-2）', () => {
    expect(() => tokenize(`盘点对象.${HIDDEN_FIELD_PLACEHOLDER}`)).toThrow(/无法识别的字符/);
    const parsed = parseFormula(`盘点对象.${HIDDEN_FIELD_PLACEHOLDER} + 1`);
    expect(parsed).toMatchObject({ ok: false, errors: [{ code: 'SYNTAX_ERROR' }] });
    const validated = validateFormula(`盘点对象.${HIDDEN_FIELD_PLACEHOLDER} + 1`, { isKnownField: () => true });
    expect(validated).toMatchObject({ ok: false, errors: [{ code: 'SYNTAX_ERROR' }] });
  });

  it('存储模式从不识别占位符（规范文本里不会有它）', () => {
    expect(() => tokenize(HIDDEN_FIELD_PLACEHOLDER, { handles: true, placeholders: true })).toThrow();
  });
});

describe('语法：句柄与占位符的位置', () => {
  it('句柄解析成带 fieldId 的字段引用，text 等于句柄原文，end 是源码结束位置', () => {
    const result = parseStoredFormula(`1 + ${HANDLE_A}`);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const body = result.program.body;
    expect(body.type).toBe('binary');
    const field = (body as Extract<typeof body, { type: 'binary' }>).right;
    expect(field).toMatchObject({ type: 'field', text: HANDLE_A, fieldId: ID_A, end: 4 + HANDLE_A.length });
  });

  it('普通字段引用也带 end（含“盘点对象 . 来源”这类带空白、换行的写法）', () => {
    const source = '盘点对象 .\n 来源 + 1';
    const result = parseFormula(source);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const field = (result.program.body as Extract<typeof result.program.body, { type: 'binary' }>).left;
    expect(field).toMatchObject({ type: 'field', text: '盘点对象.来源' });
    expect(source.slice(field.pos.offset, (field as { end: number }).end)).toBe('盘点对象 .\n 来源');
  });

  it('输入模式：占位符只能出现在“盘点对象.”之后', () => {
    const ok = parseFormula(`盘点对象.${HIDDEN_FIELD_PLACEHOLDER} + 1`, { placeholders: true });
    expect(ok.ok).toBe(true);
    for (const source of [
      HIDDEN_FIELD_PLACEHOLDER,
      `考核结果.${HIDDEN_FIELD_PLACEHOLDER}`,
      `1 + ${HIDDEN_FIELD_PLACEHOLDER}`,
    ]) {
      expect(parseFormula(source, { placeholders: true }).ok, source).toBe(false);
    }
  });

  it('句柄后不能再接“.名称”，句柄也不能出现在“.”之后', () => {
    expect(parseStoredFormula(`${HANDLE_A}.x`).ok).toBe(false);
    expect(parseStoredFormula(`盘点对象.${HANDLE_A}`).ok).toBe(false);
  });

  it('存储模式不设 4000 字上限，只保留 800 词上限', () => {
    const many = Array.from({ length: 150 }, () => HANDLE_A).join(' + ');
    expect(many.length).toBeGreaterThan(4000);
    expect(parseStoredFormula(many).ok).toBe(true);
    const tooMany = Array.from({ length: 401 }, () => HANDLE_A).join(' + ');
    expect(parseStoredFormula(tooMany).ok).toBe(false);
  });

  it('validateFormula 支持存储模式：句柄进入 fields，作为字段键', () => {
    const result = validateFormula(`${HANDLE_A} + ${HANDLE_B}`, {
      storage: true,
      isKnownField: (path) => path === HANDLE_A || path === HANDLE_B,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.fields).toEqual([HANDLE_A, HANDLE_B]);
    const unknown = validateFormula(`${HANDLE_A}`, { storage: true, isKnownField: () => false });
    expect(unknown.ok).toBe(false);
  });
});

describe('checkInputLimits：4000 字 / 800 词，与 parseFormula 同源', () => {
  it('在限制内返回 ok', () => {
    expect(checkInputLimits('1 + 2')).toEqual({ ok: true });
  });

  it('超 4000 字 → TOO_LONG；超 800 词 → TOO_MANY_TOKENS', () => {
    const long = `"${'a'.repeat(4000)}"`;
    expect(checkInputLimits(long)).toMatchObject({ ok: false, reason: 'TOO_LONG' });
    const words = Array.from({ length: 401 }, () => '1').join('+');
    expect(words.length).toBeLessThan(4000);
    expect(checkInputLimits(words)).toMatchObject({ ok: false, reason: 'TOO_MANY_TOKENS' });
    // 与 parseFormula 同一口径
    expect(parseFormula(long).ok).toBe(false);
    expect(parseFormula(words).ok).toBe(false);
  });

  it('恰在边界上的公式两边一致', () => {
    const at = `"${'a'.repeat(3998)}"`;
    expect(at.length).toBe(4000);
    expect(checkInputLimits(at)).toEqual({ ok: true });
    expect(parseFormula(at).ok).toBe(true);
    expect(checkInputLimits(`${at} `)).toMatchObject({ ok: false, reason: 'TOO_LONG' });
  });

  it('带占位符的回显文本：placeholders:true 时按词数计限制（F082-3 的第 2 步）', () => {
    const words = Array.from({ length: 401 }, () => `盘点对象.${HIDDEN_FIELD_PLACEHOLDER}`).join('+');
    expect(checkInputLimits(words, { placeholders: true })).toMatchObject({ ok: false, reason: 'TOO_MANY_TOKENS' });
    // 默认不识别占位符：词法错误交给后续语法检查
    expect(checkInputLimits(words)).toEqual({ ok: true });
  });

  it('词法错误不在这里报：交给后续语法检查（返回 ok）', () => {
    expect(checkInputLimits('1 + @')).toEqual({ ok: true });
  });
});

describe('formulaFieldIds：从规范文本取字段 ID，与字段目录无关', () => {
  it('按出现顺序去重，字符串里的句柄原文不算', () => {
    const stored = `${HANDLE_B} + ${HANDLE_A} + ${HANDLE_B} + Len("${HANDLE_A}") + 盘点对象.盘点方案`;
    expect(formulaFieldIds(stored)).toEqual([ID_B, ID_A]);
  });

  it('没有引用或词法不合法时返回空数组', () => {
    expect(formulaFieldIds('1 + 2')).toEqual([]);
    expect(formulaFieldIds('1 + @')).toEqual([]);
  });
});

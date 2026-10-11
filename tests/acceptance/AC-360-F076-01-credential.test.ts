/**
 * AC-360-F076-01 凭据生成器与规范化（F-076 PR-0；docs/08_设计/F-076 §2.2、§9 AC-01；DEC-401 Q3，差异 D-074）。
 * 领域包不碰随机源：生成器收一个 randomInt 函数（应用侧传 node:crypto 的 randomInt）。
 */
import { survey360 } from '@italent/domain';
import { describe, expect, it } from 'vitest';

const {
  CREDENTIAL_ALPHABET,
  CREDENTIAL_INPUT_MAX_LENGTH,
  PASSWORD_LENGTH,
  SERIAL_LENGTH,
  generateCredentialPair,
  generateCredentialValue,
  hasPasswordFormat,
  hasSerialFormat,
  normalizeCredentialInput,
} = survey360;

/** 确定性伪随机（mulberry32），只用于测试里反复抽样；断言不依赖具体数值。 */
function seededRandomInt(seed: number): (maxExclusive: number) => number {
  let state = seed >>> 0;
  return (maxExclusive) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * maxExclusive);
  };
}

describe('AC-360-F076-01 字母表与长度（DEC-401 Q3）', () => {
  it('字母表固定为 31 个字符，不含易混字符 0 1 I L O，且无小写、无重复', () => {
    expect(CREDENTIAL_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTUVWXYZ');
    expect(CREDENTIAL_ALPHABET).toHaveLength(31);
    expect(new Set(CREDENTIAL_ALPHABET).size).toBe(31);
    expect(CREDENTIAL_ALPHABET).not.toMatch(/[01ILOa-z]/);
  });

  it('序列号 10 位、密码 8 位、输入上限 64', () => {
    expect(SERIAL_LENGTH).toBe(10);
    expect(PASSWORD_LENGTH).toBe(8);
    expect(CREDENTIAL_INPUT_MAX_LENGTH).toBe(64);
  });
});

describe('AC-360-F076-01 生成器', () => {
  it('逐位用 randomInt(31) 取字符：下标 0..30 依次对应字母表，覆盖每个字符', () => {
    const calls: number[] = [];
    let next = 0;
    const randomInt = (max: number) => {
      calls.push(max);
      return next++ % max;
    };

    const value = generateCredentialValue(CREDENTIAL_ALPHABET.length, randomInt);

    expect(value).toBe(CREDENTIAL_ALPHABET);
    expect(new Set(calls)).toEqual(new Set([31]));
  });

  it('抽样 2000 组：长度符合 Q3、字符都在字母表内、序列号不重复', () => {
    const randomInt = seededRandomInt(20261010);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const { serial, password } = generateCredentialPair(randomInt);
      expect(serial).toHaveLength(SERIAL_LENGTH);
      expect(password).toHaveLength(PASSWORD_LENGTH);
      expect([...serial, ...password].every((ch) => CREDENTIAL_ALPHABET.includes(ch))).toBe(true);
      expect(hasSerialFormat(serial)).toBe(true);
      expect(hasPasswordFormat(password)).toBe(true);
      seen.add(serial);
    }
    // 31^10 的空间里 2000 个随机序列号几乎不可能撞；撞了说明生成器退化（如固定值）
    expect(seen.size).toBe(2000);
  });

  it('randomInt 返回越界值时直接抛错，不生成残缺凭据', () => {
    expect(() => generateCredentialValue(4, () => 31)).toThrow();
    expect(() => generateCredentialValue(4, () => -1)).toThrow();
    expect(() => generateCredentialValue(4, () => 1.5)).toThrow();
  });

  it('长度必须是正整数', () => {
    expect(() => generateCredentialValue(0, () => 0)).toThrow();
    expect(() => generateCredentialValue(-1, () => 0)).toThrow();
    expect(() => generateCredentialValue(2.5, () => 0)).toThrow();
  });
});

describe('AC-360-F076-01 规范化：不区分大小写、去空格与连字符、限长', () => {
  it('小写转大写', () => {
    expect(normalizeCredentialInput('abcd2345wx')).toBe('ABCD2345WX');
  });

  it('去掉首尾与中间的空白（含制表符、全角空格）', () => {
    expect(normalizeCredentialInput('  ABCD 2345\tWX　')).toBe('ABCD2345WX');
  });

  it('去掉连字符，邮件里常见的分段写法与连写等价', () => {
    expect(normalizeCredentialInput('abcd-2345-wx')).toBe(normalizeCredentialInput('ABCD2345WX'));
    expect(normalizeCredentialInput('--AB-CD--')).toBe('ABCD');
  });

  it('先去分隔符再限长 64：超长输入截断，不抛错', () => {
    const long = `${'A-'.repeat(100)}`;
    expect(normalizeCredentialInput(long)).toBe('A'.repeat(64));
    expect(normalizeCredentialInput('B'.repeat(200))).toHaveLength(64);
  });

  it('空串与只含分隔符的输入规范化为空串', () => {
    expect(normalizeCredentialInput('')).toBe('');
    expect(normalizeCredentialInput(' - - ')).toBe('');
  });

  it('不替换易混字符：0 与 O 不等价（字母表里本来就没有它们，登录时只会判为不匹配）', () => {
    expect(normalizeCredentialInput('0O1Il')).toBe('0O1IL');
  });

  it('幂等：规范化结果再规范化不变', () => {
    const once = normalizeCredentialInput(' ab-cd 23 ');
    expect(normalizeCredentialInput(once)).toBe(once);
  });
});

describe('AC-360-F076-01 格式校验（纯函数，登录流程不得用它提前返回）', () => {
  it('规范化后的序列号：10 位且全在字母表内', () => {
    expect(hasSerialFormat('23456789AB')).toBe(true);
    expect(hasSerialFormat('23456789A')).toBe(false);
    expect(hasSerialFormat('23456789ABC')).toBe(false);
    expect(hasSerialFormat('23456789A0')).toBe(false);
    expect(hasSerialFormat('23456789ab')).toBe(false);
  });

  it('规范化后的密码：8 位且全在字母表内', () => {
    expect(hasPasswordFormat('2345ABCD')).toBe(true);
    expect(hasPasswordFormat('2345ABC')).toBe(false);
    expect(hasPasswordFormat('2345ABCDE')).toBe(false);
    expect(hasPasswordFormat('2345ABCI')).toBe(false);
  });
});

describe('AC-360-F076-01 DEC-409④ 输入容错（全角转半角、各种横线归一化）', () => {
  const fullwidth = (text: string) =>
    [...text].map((ch) => (/[A-Za-z0-9]/.test(ch) ? String.fromCharCode(ch.charCodeAt(0) + 0xfee0) : ch)).join('');

  it('全角字母数字转半角后再做大小写与空白处理', () => {
    expect(normalizeCredentialInput(fullwidth('ab23CD'))).toBe('AB23CD');
    expect(normalizeCredentialInput('ＡＢ　２３')).toBe('AB23');
  });

  it.each([
    ['全角横线 U+FF0D', '\uff0d'],
    ['连字符 U+2010', '\u2010'],
    ['不换行连字符 U+2011', '\u2011'],
    ['数字破折号 U+2012', '\u2012'],
    ['短破折号 U+2013', '\u2013'],
    ['长横线 U+2014', '\u2014'],
    ['水平线 U+2015', '\u2015'],
    ['减号 U+2212', '\u2212'],
    ['软连字符 U+00AD', '\u00ad'],
    ['小写连字符 U+FE63', '\ufe63'],
  ])('%s 被去掉', (_name, dash) => {
    expect(normalizeCredentialInput(`ab${dash}cd${dash}23`)).toBe('ABCD23');
  });

  it('不换行空格、全角空格、零宽空格也被去掉；规范化后仍限长 64', () => {
    expect(normalizeCredentialInput('AB\u00a0CD\u3000EF\u200b23')).toBe('ABCDEF23');
    expect(normalizeCredentialInput(fullwidth('A'.repeat(80))).length).toBe(CREDENTIAL_INPUT_MAX_LENGTH);
  });

  it('规范化后的格式校验与半角输入一致', () => {
    expect(hasSerialFormat(normalizeCredentialInput(fullwidth('2345-6789-AB')))).toBe(true);
    expect(hasPasswordFormat(normalizeCredentialInput('ＡＢＣＤ－２３４５'))).toBe(true);
    expect(hasPasswordFormat(normalizeCredentialInput('ＡＢＣＤ－２３４０'))).toBe(false);
  });
});

/**
 * 通用网址作答凭据的纯规则（F-076 设计 §2.2；DEC-401 Q3，差异 D-074）。
 * 随机源由调用方注入（应用侧传 node:crypto 的 randomInt）：领域包禁止 IO，也不碰 node:*。
 * HMAC、scrypt、比较等密码学操作在 apps/api，不在这里。
 */

/** 去掉易混字符 0 1 I L O 的 31 字符大写字母表；输入不区分大小写，故不含小写。 */
export const CREDENTIAL_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SERIAL_LENGTH = 10;
export const PASSWORD_LENGTH = 8;
/** 请求体里序列号 / 密码的字符串上限，也是规范化后的截断长度（设计 §3.5）。 */
export const CREDENTIAL_INPUT_MAX_LENGTH = 64;

/** 逐位均匀取字符：randomInt(max) 必须返回 [0, max) 的整数，越界即抛错，不生成残缺凭据。 */
export function generateCredentialValue(length: number, randomInt: (maxExclusive: number) => number): string {
  if (!Number.isInteger(length) || length < 1) throw new RangeError('凭据长度必须是正整数');
  let value = '';
  for (let i = 0; i < length; i += 1) {
    const index = randomInt(CREDENTIAL_ALPHABET.length);
    if (!Number.isInteger(index) || index < 0 || index >= CREDENTIAL_ALPHABET.length) {
      throw new RangeError('随机源返回了字母表范围外的下标');
    }
    value += CREDENTIAL_ALPHABET[index];
  }
  return value;
}

export function generateCredentialPair(randomInt: (maxExclusive: number) => number): {
  readonly serial: string;
  readonly password: string;
} {
  return {
    serial: generateCredentialValue(SERIAL_LENGTH, randomInt),
    password: generateCredentialValue(PASSWORD_LENGTH, randomInt),
  };
}

/**
 * 全角字母数字（U+FF01～FF5E 整段）→ 半角；各种横线（连字符 U+2010～2015、减号 U+2212、软连字符 U+00AD、
 * 小写连字符 U+FE63、日文长音符 U+30FC / U+FF70）和零宽字符一并当作分隔符去掉（DEC-409④ 选 B）。
 */
const FULLWIDTH_OFFSET = 0xfee0;
const SEPARATORS = /[\s\u00ad\u2010-\u2015\u2212\ufe58\ufe63\u30fc\uff70\u200b-\u200d\u2060-]+/g;

/** 全角转半角后去掉空白与各种横线、转大写、限长 64。不替换易混字符：0 / O 在字母表里本来就不存在，输错只会判为不匹配。 */
export function normalizeCredentialInput(raw: string): string {
  return raw
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULLWIDTH_OFFSET))
    .replace(SEPARATORS, '')
    .toUpperCase()
    .slice(0, CREDENTIAL_INPUT_MAX_LENGTH);
}

const inAlphabet = (value: string) => [...value].every((ch) => CREDENTIAL_ALPHABET.includes(ch));

/**
 * 格式校验（入参须已规范化）。登录流程不得用它提前返回：格式不对的输入也要走同样的限频与恒定工作量，
 * 否则能从耗时区分“格式错”与“不匹配”（设计 §3.8）。
 */
export function hasSerialFormat(normalized: string): boolean {
  return normalized.length === SERIAL_LENGTH && inAlphabet(normalized);
}
export function hasPasswordFormat(normalized: string): boolean {
  return normalized.length === PASSWORD_LENGTH && inAlphabet(normalized);
}

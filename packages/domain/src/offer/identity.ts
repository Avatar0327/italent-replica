/**
 * Offer 新建时从证件号带出的信息（34 OF-R2，身份证号带出出生日期）。纯规则：只认证件类型 id_card 的 18 位号码并核对校验位，
 * 不符不带出也不报错。性别、籍贯、户籍的词表与字段本单没有（见 PR 未决），不带出。
 */
const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK_CODES = '10X98765432';

export function birthDateFromIdCard(idType: string | null | undefined, idNumber: string | null | undefined) {
  const number = idNumber?.trim().toUpperCase();
  if (idType !== 'id_card' || !number || !/^\d{17}[\dX]$/.test(number)) return null;
  const sum = WEIGHTS.reduce((total, weight, index) => total + weight * Number(number[index]), 0);
  if (CHECK_CODES[sum % 11] !== number[17]) return null;
  const [year, month, day] = [number.slice(6, 10), number.slice(10, 12), number.slice(12, 14)];
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const valid =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day);
  return valid ? `${year}-${month}-${day}` : null;
}

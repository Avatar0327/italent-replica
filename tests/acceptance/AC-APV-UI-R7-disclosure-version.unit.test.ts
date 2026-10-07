/** 第 7 轮（DEC-288 止损）：披露版本的编码 / 解码与“更收紧”判定（纯函数）。 */
import { describe, expect, it } from 'vitest';
import {
  decodeDisclosureVersion,
  disclosureTightened,
  encodeDisclosureVersion,
  type DisclosureVersion,
} from '../../apps/api/src/modules/approval/disclosure-version.js';

const base: DisclosureVersion = {
  fields: ['departmentId', 'place', 'remarks'],
  originals: ['place'],
  logFields: ['place'],
  hidden: false,
};

describe('披露版本编码', () => {
  it('编码可往返，字段顺序不影响结果；非法字符串解码为 null', () => {
    const encoded = encodeDisclosureVersion(base);
    expect(typeof encoded).toBe('string');
    expect(encoded).not.toContain(' ');
    expect(decodeDisclosureVersion(encoded)).toEqual(base);
    expect(encodeDisclosureVersion({ ...base, fields: ['remarks', 'place', 'departmentId'] })).toBe(encoded);
    for (const bad of ['', 'garbage', '1.', '1.!!!', `2.${encoded.slice(2)}`, encoded.slice(0, -4)])
      expect(decodeDisclosureVersion(bad), bad).toBeNull();
    expect(decodeDisclosureVersion('1.' + Buffer.from('[1,2]').toString('base64url'))).toBeNull();
    expect(decodeDisclosureVersion('1.' + Buffer.from('[["a"],["a"],["a"],"x"]').toString('base64url'))).toBeNull();
  });
});

describe('更收紧判定', () => {
  it('字段变少、原值变少、日志字段名变少、recordsHidden 由 false 变 true 都算收紧', () => {
    expect(disclosureTightened(base, { ...base, fields: ['departmentId', 'remarks'] })).toBe(true);
    expect(disclosureTightened(base, { ...base, originals: [] })).toBe(true);
    expect(disclosureTightened(base, { ...base, logFields: [] })).toBe(true);
    expect(disclosureTightened(base, { ...base, hidden: true })).toBe(true);
    expect(disclosureTightened(base, { ...base, fields: ['departmentId', 'remarks', 'reason'] })).toBe(true);
  });
  it('相同、只增不减、recordsHidden 由 true 变 false 都不算收紧', () => {
    expect(disclosureTightened(base, base)).toBe(false);
    expect(disclosureTightened(base, { ...base, fields: [...base.fields, 'reason'] })).toBe(false);
    expect(disclosureTightened(base, { ...base, logFields: ['place', 'remarks'] })).toBe(false);
    expect(disclosureTightened({ ...base, hidden: true, logFields: [] }, base)).toBe(false);
    expect(disclosureTightened({ ...base, fields: [], originals: [], logFields: [] }, base)).toBe(false);
  });
});

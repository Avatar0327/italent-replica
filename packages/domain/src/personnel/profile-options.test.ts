import { describe, expect, it } from 'vitest';
import {
  checkProfileOption,
  PROFILE_GENDER_OPTIONS,
  PROFILE_NATION_OPTIONS,
  PROFILE_POLITICAL_STATUS_OPTIONS,
} from './profile-options.js';

// AC-DM-30-F493-40 纯函数部分（设计 §3.6，DEC-840①）：选项原文与顺序照北森下拉
const NATIONS =
  '汉族、回族、畲族、塔塔尔族、阿昌族、哈萨克族、土家族、景颇族、哈尼族、土族、白族、维吾尔族、保安族、赫哲族、乌孜别克族、基诺族、' +
  '布依族、拉祜族、锡伯族、黎族、东乡族、蒙古族、仫佬族、达斡尔族、藏族、毛南族、裕固族、俄罗斯族、德昂族、傈僳族、瑶族、朝鲜族、' +
  '布朗族、满族、彝族、门巴族、侗族、苗族、佤族、羌族、独龙族、怒族、珞巴族、普米族、傣族、纳西族、高山族、壮族、鄂伦春族、塔吉克族、' +
  '京族、仡佬族、鄂温克族、撒拉族、柯尔克孜族、水族、穿青人、其他、革族、革家人';
const POLITICAL =
  '群众、中共党员、中共预备党员、入党积极分子、共青团员、民革党员、民盟盟员、民建会员、民进会员、农工党党员、致公党党员、' +
  '九三学社社员、台盟盟员、无党派人士、其他';

describe('F-493 性别 / 民族 / 政治面貌选项常量', () => {
  it('项数 3 / 60 / 15，顺序与设计 §3.6 一致，无重复', () => {
    expect(PROFILE_GENDER_OPTIONS).toEqual(['男', '女', '保密']);
    expect(PROFILE_NATION_OPTIONS).toHaveLength(60);
    expect(PROFILE_NATION_OPTIONS.join('、')).toBe(NATIONS);
    expect(PROFILE_POLITICAL_STATUS_OPTIONS).toHaveLength(15);
    expect(PROFILE_POLITICAL_STATUS_OPTIONS.join('、')).toBe(POLITICAL);
    for (const list of [PROFILE_GENDER_OPTIONS, PROFILE_NATION_OPTIONS, PROFILE_POLITICAL_STATUS_OPTIONS]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

describe('F-493 选项校验纯函数 checkProfileOption', () => {
  it('去首尾空白后与某项逐字相等才通过，返回选项原文', () => {
    expect(checkProfileOption(PROFILE_GENDER_OPTIONS, ' 男 ')).toEqual({ ok: true, value: '男' });
    expect(checkProfileOption(PROFILE_NATION_OPTIONS, '革家人')).toEqual({ ok: true, value: '革家人' });
    expect(checkProfileOption(PROFILE_POLITICAL_STATUS_OPTIONS, '\t中共党员\n')).toEqual({
      ok: true,
      value: '中共党员',
    });
  });

  it('空值放行且不填默认值（value = null）', () => {
    for (const raw of [null, undefined, '', '   ']) {
      expect(checkProfileOption(PROFILE_GENDER_OPTIONS, raw)).toEqual({ ok: true, value: null });
    }
  });

  it('同义词、简写、英文、乱填、大小写与全角半角一律不通过', () => {
    for (const raw of ['M', 'F', '男性', 'abc', 'Ｍ', 'm']) {
      expect(checkProfileOption(PROFILE_GENDER_OPTIONS, raw), raw).toEqual({ ok: false });
    }
    for (const raw of ['汉', 'Han', '汉 族', '汉族族']) {
      expect(checkProfileOption(PROFILE_NATION_OPTIONS, raw), raw).toEqual({ ok: false });
    }
    for (const raw of ['党员', '团员', '中共 党员']) {
      expect(checkProfileOption(PROFILE_POLITICAL_STATUS_OPTIONS, raw), raw).toEqual({ ok: false });
    }
  });

  it('选项集合各管各的：民族里的值填在性别列不通过', () => {
    expect(checkProfileOption(PROFILE_GENDER_OPTIONS, '汉族')).toEqual({ ok: false });
  });
});

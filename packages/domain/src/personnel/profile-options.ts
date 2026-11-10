/**
 * F-493 §3.6 性别 / 民族 / 政治面貌选项（DEC-840①，F-499）：原文与顺序照北森下拉。
 * 档案字段仍是自由文本（fields.ts 不改）；只有历史离职导入按这三个常量校验，手工编辑不受约束。
 */
export const PROFILE_GENDER_OPTIONS: readonly string[] = ['男', '女', '保密'];

// prettier-ignore
export const PROFILE_NATION_OPTIONS: readonly string[] = [
  '汉族', '回族', '畲族', '塔塔尔族', '阿昌族', '哈萨克族', '土家族', '景颇族', '哈尼族', '土族',
  '白族', '维吾尔族', '保安族', '赫哲族', '乌孜别克族', '基诺族', '布依族', '拉祜族', '锡伯族', '黎族',
  '东乡族', '蒙古族', '仫佬族', '达斡尔族', '藏族', '毛南族', '裕固族', '俄罗斯族', '德昂族', '傈僳族',
  '瑶族', '朝鲜族', '布朗族', '满族', '彝族', '门巴族', '侗族', '苗族', '佤族', '羌族',
  '独龙族', '怒族', '珞巴族', '普米族', '傣族', '纳西族', '高山族', '壮族', '鄂伦春族', '塔吉克族',
  '京族', '仡佬族', '鄂温克族', '撒拉族', '柯尔克孜族', '水族', '穿青人', '其他', '革族', '革家人',
];

// prettier-ignore
export const PROFILE_POLITICAL_STATUS_OPTIONS: readonly string[] = [
  '群众', '中共党员', '中共预备党员', '入党积极分子', '共青团员', '民革党员', '民盟盟员', '民建会员',
  '民进会员', '农工党党员', '致公党党员', '九三学社社员', '台盟盟员', '无党派人士', '其他',
];

export type ProfileOptionCheck = { readonly ok: true; readonly value: string | null } | { readonly ok: false };

/**
 * 去首尾空白后必须与某项逐字相等：不转大小写、不做全角半角转换，同义词一律不通过（F-499 第 02～08、11 行）。
 * 空值放行且 value = null——调用方不得填默认值（F-499 第 09 行）。
 */
export function checkProfileOption(options: readonly string[], raw: string | null | undefined): ProfileOptionCheck {
  const text = raw?.trim() ?? '';
  if (text === '') return { ok: true, value: null };
  return options.includes(text) ? { ok: true, value: text } : { ok: false };
}

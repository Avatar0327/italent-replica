import { presetLabels } from '../transfer/messages.js';
import { detailText as d, fieldLabels } from './messages.js';
import { NAME_KEYS } from './named-fields.js';

export interface FieldGroup {
  title: string;
  fields: { key: string; label: string }[];
}

/** 调动信息：只放现有调动字段里能对上原站“调动信息”的项（§3.8），其余原站项没有来源不做。 */
const infoLabels: Readonly<Record<string, string>> = {
  effectiveDate: '调动日期',
  transferTypeCode: fieldLabels.transferTypeCode!,
  reasonCode: fieldLabels.reasonCode!,
  gender: '性别',
  age: '年龄',
  jobNumber: presetLabels.jobNumber!,
};
/** 任职调整里原站写“新…”的两项；其余预置字段沿用任职字段名。 */
const adjustLabels: Readonly<Record<string, string>> = {
  departmentId: '新部门',
  directManagerId: '新直线经理',
};

/**
 * 我的申请详情的表单分组。只对调动实例分组；其他业务类型按自己的字段平铺（DEC-799：不按标题或状态猜模板），
 * 所以这里返回 undefined 让调用方沿用平铺呈现。没有归入两组的键放“其他信息”，不隐藏数据。
 */
export function applicationGroups(approvalType: string, values: Readonly<Record<string, unknown>>) {
  if (approvalType !== 'transfer') return undefined;
  const keys = Object.keys(values).filter((key) => !NAME_KEYS.has(key));
  const info = keys.filter((key) => key in infoLabels);
  const adjust = keys.filter((key) => !(key in infoLabels) && (key in adjustLabels || key in presetLabels));
  const other = keys.filter((key) => !info.includes(key) && !adjust.includes(key));
  const group = (title: string, list: string[], labels: Readonly<Record<string, string>>): FieldGroup => ({
    title,
    fields: list.map((key) => ({ key, label: labels[key] ?? presetLabels[key] ?? fieldLabels[key] ?? key })),
  });
  return [
    group(d.transferInfo, info, infoLabels),
    group(d.transferAdjust, adjust, adjustLabels),
    group(d.otherInfo, other, {}),
  ].filter((item) => item.fields.length);
}

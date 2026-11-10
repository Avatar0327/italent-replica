/**
 * 签署模板变量（F-481 设计 §3.3）：保存模板时检查变量名，发起时替换并把结果快照到任务文件。
 * 变量名与文案是业务术语，保持和 docs 同一写法（简体中文，DEC-045）。
 */

export const ESIGN_TEMPLATE_VARIABLES = [
  '员工姓名',
  '工号',
  '调动生效日期',
  '调出部门',
  '调出职位',
  '调入部门',
  '调入职位',
  '新合同开始日期',
  '新合同结束日期',
  '发起日期',
  '企业名称',
] as const;

export type EsignTemplateVariable = (typeof ESIGN_TEMPLATE_VARIABLES)[number];

/** 值为空时的显示（工号为空、没有合同联动等，与 F-493 §3.5 同一口径）。 */
export const ESIGN_EMPTY_VALUE = '--';

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** 正文里用到、但不在变量表中的占位符（去重，保持出现顺序）；空数组表示全部合法。 */
export function unknownTemplateVariables(body: string): string[] {
  const unknown: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!(ESIGN_TEMPLATE_VARIABLES as readonly string[]).includes(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

export type EsignVariableValues = Readonly<Partial<Record<EsignTemplateVariable, string | null | undefined>>>;

/** 替换变量：值缺失或为空串显示“--”；占位符不在变量表中时抛错（保存时已拦截，这里是保底，对应 RENDER_FAILED）。 */
export function renderTemplateBody(body: string, values: EsignVariableValues): string {
  return body.replace(PLACEHOLDER, (_, name: string) => {
    if (!(ESIGN_TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
      throw new Error(`未知的签署模板变量：${name}`);
    }
    const value = values[name as EsignTemplateVariable];
    return value === undefined || value === null || value.trim() === '' ? ESIGN_EMPTY_VALUE : value;
  });
}

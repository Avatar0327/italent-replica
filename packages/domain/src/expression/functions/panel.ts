/**
 * 公式编辑器【函数】面板目录（取证 Q-M0-81，`26` §8.6；DEC-260）：按原站分类与面板原名列出，供 R3-T04 编辑器展示。
 * 每个条目的 label 都能在默认注册表里解析（Def 是语法，不是函数）；注册表里另有评定专用函数与 R3-T00 时的
 * 兼容函数（ToText、DateFormat、DateDiff……），不在面板上。
 * TODO(需取证 #105)：日期类面板标“26 个”，§8.6 只列出 24 个名字；面板总数标 63，与分类合计不一致。
 */

export type PanelCategory = '业务函数' | '日期函数' | '逻辑函数' | '数学函数' | '统计函数' | '文本函数' | '其它函数';

export interface PanelEntry {
  readonly category: PanelCategory;
  /** 面板原名。 */
  readonly label: string;
  /** 面板上的参数占位（原文，如 "( , , )"），没有占位的为空串。 */
  readonly placeholder: string;
  /** Def 是变量定义语法，由语法分析处理。 */
  readonly syntax?: 'def';
}

const entries = (category: PanelCategory, list: readonly (readonly [string, string?])[]): PanelEntry[] =>
  list.map(([label, placeholder = '']) => ({ category, label, placeholder }));

export const FUNCTION_PANEL: readonly PanelEntry[] = [
  ...entries('业务函数', [
    ['获取人事子集的指定字段数据', '(,,,)'],
    ['获取最近一次360总分', '( , )'],
    ['获取当前人员测评测验下的最近一次测评得分/维度得分', '( , )'],
    ['获取指定年度指定周期的绩效得分', '( , , )'],
    ['获取指定年度指定周期的绩效等级', '( , , )'],
    ['获取最近第N年的绩效考核得分', '( , )'],
    ['获取最近第N年的绩效考核等级', '( , )'],
    ['获取最近第N次绩效考核得分', '( , , )'],
    ['获取最近第N次绩效考核等级', '( , , )'],
    ['按照参数规则获取数据', '()'],
    ['获取某个结果在指定人员范围内的排名', '( , , , )'],
    ['获取最近一次人才评定数据', '(,,,)'],
  ]),
  ...entries('日期函数', [
    ['Today'],
    ['Now'],
    ['DayOfYear'],
    ['Year'],
    ['Month'],
    ['Day'],
    ['Hour'],
    ['Minute'],
    ['Second'],
    ['WeekDay'],
    ['Time'],
    ['ToDate'],
    ['FirstDay'],
    ['LastDay'],
    ['NextMonth'],
    ['AddYears'],
    ['AddMonths'],
    ['AddDays'],
    ['AddHours'],
    ['AddMinutes'],
    ['Days'],
    ['Years'],
    ['Minutes'],
    ['有效时长', '( , , , , , )'],
  ]),
  ...entries('逻辑函数', [
    ['AND'],
    ['OR'],
    ['IF', '( , , )'],
    ['IN'],
    ['NOTIN'],
    ['是否为空'],
    ['判断为空'],
    ['判断不为空'],
  ]),
  ...entries('数学函数', [
    ['Round'],
    ['RoundUP'],
    ['RoundDown'],
    ['四舍五入', '( , )'],
    ['INT'],
    ['Floor'],
    ['Ceiling'],
    ['Abs'],
    ['Mod'],
  ]),
  ...entries('统计函数', [['Average'], ['Sum'], ['Max'], ['Min'], ['Count']]),
  ...entries('文本函数', [['Concatenate'], ['ToNumber']]),
  ...entries('其它函数', [['ShowText']]),
  { category: '其它函数', label: 'Def', placeholder: '( , );', syntax: 'def' },
];

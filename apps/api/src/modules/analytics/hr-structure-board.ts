/**
 * 人员结构分析看板 6.01～6.14 与员工结构两张报表的计算（规格 35“补充：BE-13…”B49、“员工结构两张报表”B53）。
 * 输入是 structurePeople 的同一份行集；每个组件只定义“计入谁”（members）与“分到哪组”（key），数字、分组计数与明细
 * 都由这两个函数得出，数字 = 明细条数。分段一律用 domain 的 hr-analysis/segments（BE-13b 流动同用）。
 */
import {
  AGE_SEGMENTS,
  ageSample,
  ageSegment,
  BACHELOR_OR_ABOVE,
  EDUCATION_TIERS,
  educationTier,
  EMPLOYEE_STATUS,
  GENDER_SEGMENTS,
  genderSegment,
  HR_STRUCTURE_COMPONENTS,
  HR_STRUCTURE_TOP_INSTITUTIONS,
  SEGMENT_NONE,
  segmentAverage,
  TENURE_SEGMENTS,
  tenureSample,
  tenureSegment,
  type HrStructureCode,
  type HrStructureReportCode,
} from '@italent/domain';
import type { DictionaryItem, OrgTree, StructurePerson } from './hr-structure.js';

type Person = StructurePerson;
interface Option {
  readonly key: string;
  readonly label: string;
}
/** 计算组件与报表需要的时点资料：组织树与职务字典。 */
export interface StructureLookup {
  readonly asOf: string;
  readonly tree: OrgTree;
  readonly sequences: readonly DictionaryItem[];
  readonly levels: readonly DictionaryItem[];
}

const NONE: Option = { key: SEGMENT_NONE, label: '空' };
const STATUS: readonly Option[] = [
  { key: 'regular', label: '正式' },
  { key: 'probation', label: '试用' },
];
const probation = (p: Person) => p.employeeStatus === EMPLOYEE_STATUS.probation;
export const ratio = (count: number, total: number) => (total ? Math.round((count / total) * 10_000) / 10_000 : null);

interface Rule {
  /** 计入谁：value / average 的样本、ratio 的分子；缺省 = 全部。 */
  readonly members?: (p: Person, x: StructureLookup) => boolean;
  /** 分组键（groups / ratio）。 */
  readonly key?: (p: Person, x: StructureLookup) => string;
  /** 固定分段（零值也列出，空值段排最后）；缺省按出现的键、人数降序。 */
  readonly fixed?: readonly Option[];
  readonly label?: (key: string, x: StructureLookup) => string;
  readonly limit?: number;
  readonly sample?: (p: Person, asOf: string) => number | null;
}

const dictionaryLabel =
  (items: (x: StructureLookup) => readonly DictionaryItem[]) => (key: string, x: StructureLookup) =>
    key === SEGMENT_NONE ? NONE.label : (items(x).find((item) => item.id === key)?.name ?? key);
const institution = (p: Person, x: StructureLookup) => x.tree.institution(p.departmentId);
const orgLabel = (key: string, x: StructureLookup) => x.tree.name(key);
const withNone = (options: readonly { key: string; label: string }[]) => [...options, NONE];

const RULES: Readonly<Record<HrStructureCode, Rule | null>> = {
  '6.01': {},
  '6.02': { sample: (p, asOf) => ageSample(p.birthday, asOf) },
  '6.03': { sample: (p, asOf) => tenureSample(p.entryDate, asOf) },
  '6.04': { key: institution, label: orgLabel, limit: HR_STRUCTURE_TOP_INSTITUTIONS },
  '6.05': { key: (p) => p.levelId ?? SEGMENT_NONE, label: dictionaryLabel((x) => x.levels) },
  '6.06': { key: (p) => p.sequenceId ?? SEGMENT_NONE, label: dictionaryLabel((x) => x.sequences) },
  '6.07': { key: (p) => (probation(p) ? 'probation' : 'regular'), fixed: STATUS },
  '6.08': { key: (p, x) => tenureSegment(p.entryDate, x.asOf), fixed: withNone(TENURE_SEGMENTS) },
  // 工作地点 / 籍贯：复刻任职与档案里没有可统计的字典字段（规格“未决 / 假设”），返回 null，不造数据
  '6.09': null,
  '6.10': null,
  '6.11': {
    key: institution,
    label: orgLabel,
    limit: HR_STRUCTURE_TOP_INSTITUTIONS,
    members: (p) => BACHELOR_OR_ABOVE.includes(educationTier(p.educationLevel)),
  },
  '6.12': { key: (p) => educationTier(p.educationLevel), fixed: withNone(EDUCATION_TIERS) },
  '6.13': { key: (p, x) => ageSegment(p.birthday, x.asOf), fixed: withNone(AGE_SEGMENTS) },
  '6.14': { key: (p) => genderSegment(p.gender), fixed: withNone(GENDER_SEGMENTS) },
};

function member(rule: Rule, p: Person, x: StructureLookup): boolean {
  if (rule.sample) return rule.sample(p, x.asOf) !== null;
  return rule.members ? rule.members(p, x) : true;
}

/** 组件的明细人员（group 给出时只取该组）：与数字同一份 members / key。 */
export function componentMembers(code: HrStructureCode, people: readonly Person[], x: StructureLookup, group?: string) {
  const rule = RULES[code];
  if (!rule) return null;
  return people.filter((p) => member(rule, p, x) && (group === undefined || rule.key?.(p, x) === group));
}

export function isGrouped(code: HrStructureCode) {
  return !!RULES[code]?.key;
}

function groups(rule: Rule, people: readonly Person[], x: StructureLookup) {
  const key = rule.key!;
  const totals = new Map<string, number>();
  const hits = new Map<string, number>();
  for (const p of people) {
    const k = key(p, x);
    totals.set(k, (totals.get(k) ?? 0) + 1);
    if (member(rule, p, x)) hits.set(k, (hits.get(k) ?? 0) + 1);
  }
  const options: Option[] = rule.fixed
    ? [...rule.fixed, ...[...totals.keys()].filter((k) => !rule.fixed!.some((o) => o.key === k)).map(option(rule, x))]
    : [...totals.keys()]
        .sort((a, b) => (a === SEGMENT_NONE ? 1 : 0) - (b === SEGMENT_NONE ? 1 : 0) || totals.get(b)! - totals.get(a)!)
        .slice(0, rule.limit)
        .map(option(rule, x));
  // 空值段固定排最后（固定分段之外出现的原值，如性别的其他字典值，排在空值之前）
  options.sort((a, b) => (a.key === SEGMENT_NONE ? 1 : 0) - (b.key === SEGMENT_NONE ? 1 : 0));
  return options.map(({ key: k, label }) => {
    const count = hits.get(k) ?? 0;
    if (!rule.members) return { key: k, label, count };
    const total = totals.get(k) ?? 0;
    return { key: k, label, count, total, ratio: ratio(count, total) };
  });
}
const option = (rule: Rule, x: StructureLookup) => (key: string) => ({ key, label: rule.label?.(key, x) ?? key });

/** 看板 14 个组件（与图形无关的数据）。 */
export function structureComponents(people: readonly Person[], x: StructureLookup) {
  return HR_STRUCTURE_COMPONENTS.map((component) => {
    const rule = RULES[component.code];
    if (!rule) return { ...component, value: null, groups: null };
    const members = componentMembers(component.code, people, x)!;
    if (rule.sample) {
      const samples = members.map((p) => rule.sample!(p, x.asOf)!);
      return { ...component, value: segmentAverage(samples), count: samples.length, groups: null };
    }
    return { ...component, value: members.length, groups: rule.key ? groups(rule, people, x) : null };
  });
}

// ---- 报表（B53）：一级组织 × 列；列是对一组人员求值的函数，行与合计共用 -------------------------------------------------

interface Column extends Option {
  readonly value: (people: readonly Person[]) => number | null;
}
const count = (key: string, label: string, test: (p: Person) => boolean): Column => ({
  key,
  label,
  value: (people) => people.filter(test).length,
});
const average = (key: string, label: string, sample: (p: Person) => number | null): Column => ({
  key,
  label,
  value: (people) => segmentAverage(people.map(sample).filter((v): v is number => v !== null)),
});
const total: Column = { key: 'total', label: '合计', value: (people) => people.length };
const genders = GENDER_SEGMENTS.slice(0, 2).map(({ key, label }) =>
  count(`gender:${key}`, label, (p) => genderSegment(p.gender) === key),
);

function qualityColumns(x: StructureLookup): Column[] {
  return [
    total,
    ...genders,
    ...EDUCATION_TIERS.map((t) =>
      count(`education:${t.key}`, t.label, (p) => educationTier(p.educationLevel) === t.key),
    ),
    ...TENURE_SEGMENTS.map((s) =>
      count(`tenure:${s.key}`, s.label, (p) => tenureSegment(p.entryDate, x.asOf) === s.key),
    ),
    average('avgTenure', '平均司龄', (p) => tenureSample(p.entryDate, x.asOf)),
    ...AGE_SEGMENTS.map((s) => count(`age:${s.key}`, s.label, (p) => ageSegment(p.birthday, x.asOf) === s.key)),
    average('avgAge', '平均年龄', (p) => ageSample(p.birthday, x.asOf)),
  ];
}

const EMPLOY_TYPES: readonly Option[] = [
  { key: 'internal', label: '内部员工' },
  { key: 'intern', label: '实习生' },
];
const present = (people: readonly Person[], pick: (p: Person) => string | null) =>
  [...new Set(people.map(pick).filter((v): v is string => !!v))].sort();

function positionColumns(people: readonly Person[], x: StructureLookup): Column[] {
  const active = (items: readonly DictionaryItem[]) => items.filter((item) => item.active);
  return [
    total,
    ...EMPLOY_TYPES.flatMap(({ key, label }) => {
      const hit = (p: Person) => p.employType === key;
      return [
        count(`employType:${key}`, label, hit),
        {
          key: `employType:${key}:ratio`,
          label: `${label}占比`,
          value: (g: readonly Person[]) => ratio(g.filter(hit).length, g.length),
        },
      ];
    }),
    count(`status:${EMPLOYEE_STATUS.probation}`, '试用', probation),
    count(`status:${EMPLOYEE_STATUS.regular}`, '正式', (p) => p.employeeStatus === EMPLOYEE_STATUS.regular),
    // 人员来源 / 人员类别是自由文本（复刻没有字典），按范围内出现的值展开；序列与职级按 asOf 当天有效的字典展开
    ...present(people, (p) => p.employmentSource).map((v) => count(`source:${v}`, v, (p) => p.employmentSource === v)),
    ...present(people, (p) => p.employmentType).map((v) => count(`category:${v}`, v, (p) => p.employmentType === v)),
    ...active(x.sequences).map((s) => count(`sequence:${s.id}`, s.name, (p) => p.sequenceId === s.id)),
    ...active(x.levels).map((l) => count(`level:${l.id}`, l.name, (p) => p.levelId === l.id)),
    ...genders,
  ];
}

/** 一张报表：行 = 有人的一级组织（按名称），summary = 全部人员；单元格与列同一函数。 */
export function structureReport(code: HrStructureReportCode, people: readonly Person[], x: StructureLookup) {
  const columns = code === 'quality' ? qualityColumns(x) : positionColumns(people, x);
  const cells = (group: readonly Person[]) =>
    Object.fromEntries(columns.map((column) => [column.key, column.value(group)]));
  const byOrg = new Map<string, Person[]>();
  for (const p of people) {
    const org = x.tree.level1(p.departmentId);
    byOrg.set(org, [...(byOrg.get(org) ?? []), p]);
  }
  const rows = [...byOrg.entries()]
    .map(([organizationId, group]) => ({
      organizationId,
      organizationName: x.tree.name(organizationId),
      cells: cells(group),
    }))
    .sort(
      (a, b) =>
        a.organizationName.localeCompare(b.organizationName, 'zh') || a.organizationId.localeCompare(b.organizationId),
    );
  return {
    columns: columns.map(({ key, label }) => ({ key, label })),
    rows,
    summary: { cells: cells(people) },
  };
}

/** 看板级 / 报表筛选：任职机构、任职部门（含下级）、职务序列、用工形式、人员类别；数字与明细都先过这一步。 */
export interface StructureFilter {
  readonly institutionId?: string;
  readonly departmentId?: string;
  readonly sequenceId?: string;
  readonly employmentForm?: string;
  readonly employmentType?: string;
}

export function filterPeople(people: readonly Person[], filter: StructureFilter, tree: OrgTree): Person[] {
  const f = filter;
  return people.filter(
    (p) =>
      (!f.institutionId || tree.institution(p.departmentId) === f.institutionId) &&
      (!f.departmentId || tree.chain(p.departmentId).includes(f.departmentId)) &&
      (!f.sequenceId || p.sequenceId === f.sequenceId) &&
      (!f.employmentForm || p.employmentForm === f.employmentForm) &&
      (!f.employmentType || p.employmentType === f.employmentType),
  );
}

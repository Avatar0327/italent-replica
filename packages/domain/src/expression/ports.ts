/**
 * 取数端口（REQ-EXP-001 第 4 条）：引擎不直接查库，绩效 / 360 / 测评 / 排名 / 评定数据由使用方按批次预先读出后
 * 以同步读取器形式注入（真实数据源由 R3-T04 / T05 / T06 接线；360 由 R3-T03、人才评定由 R3-T02 接线，
 * 人事子集与参数规则由后续任务接线，F-033 只定端口签名与内存替身）。
 * 端口契约预留按查看人的字段权限 / 范围裁剪：无权或取不到时返回 forbidden / unavailable，引擎转成失败原因，
 * 失败信息不包含被隐藏字段的取数结果。
 * 端口实现方负责：只返回查看人有权读取的数据；已删除 / 作废 / 撤销的记录不返回（AGENTS.md §10 的裁剪与统计口径在数据源一侧落实）。
 */
import { EMPTY, isOptionValue, option, type ExprValue, type PlainValue } from './values.js';

/** 字段读取结果：未知字段与无权字段分开，便于给出不同的失败原因。 */
export type FieldLookup =
  | { readonly status: 'found'; readonly value: PlainValue }
  | { readonly status: 'unknown' }
  | { readonly status: 'forbidden' };

/** 被计算的对象（盘点对象、组织、职位……）：按完整路径（如 盘点对象.绩效得分）读字段。 */
export interface SubjectReader {
  readonly id: string;
  resolveField(path: string): FieldLookup;
}

export type PortOutcome<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly reason: 'forbidden' | 'unavailable' };

/** 人员子集「考核结果」的一行：字段键为子集字段名（年度、周期名称、得分、等级……）。 */
export interface PerformanceRecord {
  readonly fields: Readonly<Record<string, PlainValue>>;
  /** 同年同周期多条取最后修改的（`26` §3.5 TR-R28）。 */
  readonly modifiedAt: Date;
}

/**
 * 360 结果的一行（活动 × 角色 / 维度 / 题目）：字段键如 套卷名称、活动名称、角色名称、角色得分、问卷-他评总分。
 * 🟡 DEC-262②：“最近一次”只取已结束且报告已生成的活动，按结束时间倒序、结束时间相同按报告生成时间倒序；
 * 进行中活动（无结束时间）与报告未生成的活动不计。数据源（R3-T03）照此填写两个时间，并按查看人权限裁剪。
 */
export interface Survey360Record {
  readonly fields: Readonly<Record<string, PlainValue>>;
  /** 活动开始时间：只作说明，DEC-262② 起不参与“最近一次”排序。 */
  readonly startAt?: Date;
  /** 活动结束时间；进行中为空。 */
  readonly endAt?: Date;
  /** 报告生成时间；未生成为空。 */
  readonly reportGeneratedAt?: Date;
  /** 活动标识：同一活动的多行共用；不给时按（结束时间, 报告生成时间）区分活动。 */
  readonly activityId?: string;
}

/** 人员子集「测验结果」的一行（DEC-031）：测验名称、维度名称、总分、维度得分、测验时间、来源。 */
export interface AssessmentRecord {
  readonly fields: Readonly<Record<string, PlainValue>>;
  readonly testedAt: Date;
}

/**
 * 人才评定结果的一行（R3-T02）：字段键如 活动名称、得分、等级。
 * “最近一次”只取已通过的评定，按通过时间倒序（DEC-260；🟡 “已通过”的含义待取证 #105）。
 */
export interface TalentReviewRecord {
  readonly fields: Readonly<Record<string, PlainValue>>;
  readonly passed: boolean;
  readonly passedAt: Date;
}

/** 人事子集的一行：字段键为子集字段名（如 教育经历 的 学历、学校）。 */
export interface PersonnelSubsetRecord {
  readonly fields: Readonly<Record<string, PlainValue>>;
}

export interface ReviewJudge {
  readonly id: string;
  readonly score?: number | null;
  readonly result?: PlainValue;
  /** 弃权评委不参与统计（`24` EV-R8）。 */
  readonly abstained?: boolean;
}

export interface ReviewModule {
  readonly name: string;
  readonly score?: number | null;
  readonly result?: PlainValue;
  readonly judges: readonly ReviewJudge[];
}

export interface PerformancePort {
  records(subjectId: string): PortOutcome<readonly PerformanceRecord[]>;
}
export interface Survey360Port {
  records(subjectId: string): PortOutcome<readonly Survey360Record[]>;
}
export interface AssessmentPort {
  records(subjectId: string): PortOutcome<readonly AssessmentRecord[]>;
}
export interface ReviewPort {
  modules(subjectId: string): PortOutcome<readonly ReviewModule[]>;
}
export interface TalentReviewPort {
  records(subjectId: string): PortOutcome<readonly TalentReviewRecord[]>;
}
/** 人事子集：按子集名（如 教育经历）读该员工的全部行。 */
export interface PersonnelSubsetPort {
  records(subjectId: string, subset: string): PortOutcome<readonly PersonnelSubsetRecord[]>;
}
/**
 * “按照参数规则获取数据”：参数含义与规则配置位置待取证（#105），端口收到已求值的参数，返回一个值。
 */
export interface ParameterRulePort {
  value(subjectId: string, parameters: readonly ExprValue[]): PortOutcome<PlainValue>;
}
/** 排名的人员范围：未提供时批量求值用本次计算对象作为范围。 */
export interface RankingPort {
  population(): PortOutcome<readonly SubjectReader[]>;
}

export interface DataSourcePorts {
  readonly performance?: PerformancePort;
  readonly survey360?: Survey360Port;
  readonly assessment?: AssessmentPort;
  readonly review?: ReviewPort;
  readonly ranking?: RankingPort;
  readonly talentReview?: TalentReviewPort;
  readonly personnelSubset?: PersonnelSubsetPort;
  readonly parameterRule?: ParameterRulePort;
}

export type PortName = keyof DataSourcePorts;

/** 普通 JS 值 → 引擎值；Date 瞬时需要时区，由求值器注入（见 FunctionEnvironment.fromPlain）。 */
export function plainToValue(value: PlainValue, dateFromInstant: (instant: Date) => ExprValue): ExprValue {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === 'number') return Number.isFinite(value) ? { kind: 'number', value } : EMPTY;
  if (typeof value === 'string') return { kind: 'text', value };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? EMPTY : dateFromInstant(value);
  if (isOptionValue(value)) return option(value.optionValue, value.label);
  return EMPTY;
}

// ---------- 内存替身 ----------

export interface InMemorySubjectOptions {
  /** 查看人无权看的字段路径。 */
  readonly forbidden?: readonly string[];
}

export function inMemorySubject(
  id: string,
  fields: Readonly<Record<string, PlainValue>>,
  options: InMemorySubjectOptions = {},
): SubjectReader {
  const forbidden = new Set(options.forbidden ?? []);
  return {
    id,
    resolveField(path) {
      if (forbidden.has(path)) return { status: 'forbidden' };
      if (!Object.hasOwn(fields, path)) return { status: 'unknown' };
      return { status: 'found', value: fields[path] };
    },
  };
}

export interface InMemoryRankingMember {
  readonly id: string;
  readonly fields: Readonly<Record<string, PlainValue>>;
  readonly forbidden?: readonly string[];
}

export interface InMemoryPortData {
  readonly performance?: Readonly<Record<string, readonly PerformanceRecord[]>>;
  readonly survey360?: Readonly<Record<string, readonly Survey360Record[]>>;
  readonly assessment?: Readonly<Record<string, readonly AssessmentRecord[]>>;
  readonly review?: Readonly<Record<string, readonly ReviewModule[]>>;
  readonly ranking?: readonly InMemoryRankingMember[];
  readonly talentReview?: Readonly<Record<string, readonly TalentReviewRecord[]>>;
  /** 对象 ID → 子集名 → 行。 */
  readonly personnelSubset?: Readonly<Record<string, Readonly<Record<string, readonly PersonnelSubsetRecord[]>>>>;
  /** 参数规则替身：按对象与已求值参数给出值。 */
  readonly parameterRule?: (subjectId: string, parameters: readonly ExprValue[]) => PlainValue;
  /** 模拟无权：某端口对某些对象返回 forbidden。 */
  readonly forbidden?: Partial<Readonly<Record<Exclude<PortName, 'ranking'>, readonly string[]>>>;
  /** 模拟数据源不可用：整个端口返回 unavailable。 */
  readonly unavailable?: readonly PortName[];
}

type PerSubjectPortName = Exclude<PortName, 'ranking' | 'personnelSubset' | 'parameterRule'>;

/** 按对象给出结果的替身：数据源不可用 / 对该对象无权 / 正常三种情况。 */
function inMemoryOutcome<T>(
  name: Exclude<PortName, 'ranking'>,
  data: InMemoryPortData,
  subjectId: string,
  read: () => T,
): PortOutcome<T> {
  if (data.unavailable?.includes(name)) return { ok: false, reason: 'unavailable' };
  if (data.forbidden?.[name]?.includes(subjectId)) return { ok: false, reason: 'forbidden' };
  return { ok: true, data: read() };
}

function inMemoryPort<T>(
  name: PerSubjectPortName,
  data: InMemoryPortData,
  rows: Readonly<Record<string, readonly T[]>> | undefined,
): { records(subjectId: string): PortOutcome<readonly T[]> } | undefined {
  if (rows === undefined && !data.unavailable?.includes(name)) return undefined;
  return { records: (subjectId) => inMemoryOutcome(name, data, subjectId, () => rows?.[subjectId] ?? []) };
}

function provided(data: InMemoryPortData, name: PortName): boolean {
  return data[name] !== undefined || (data.unavailable?.includes(name) ?? false);
}

/** 内存端口：测试与使用方本地试算用；真实实现按同一契约接线。 */
export function createInMemoryPorts(data: InMemoryPortData): DataSourcePorts {
  const review = inMemoryPort<ReviewModule>('review', data, data.review);
  const ranking: RankingPort | undefined =
    data.ranking === undefined && !data.unavailable?.includes('ranking')
      ? undefined
      : {
          population: () =>
            data.unavailable?.includes('ranking')
              ? { ok: false, reason: 'unavailable' }
              : {
                  ok: true,
                  data: (data.ranking ?? []).map((m) => inMemorySubject(m.id, m.fields, { forbidden: m.forbidden })),
                },
        };
  return {
    performance: inMemoryPort<PerformanceRecord>('performance', data, data.performance),
    survey360: inMemoryPort<Survey360Record>('survey360', data, data.survey360),
    assessment: inMemoryPort<AssessmentRecord>('assessment', data, data.assessment),
    review: review ? { modules: (subjectId) => review.records(subjectId) } : undefined,
    ranking,
    talentReview: inMemoryPort<TalentReviewRecord>('talentReview', data, data.talentReview),
    personnelSubset: provided(data, 'personnelSubset')
      ? {
          records: (subjectId, subset) =>
            inMemoryOutcome(
              'personnelSubset',
              data,
              subjectId,
              () => data.personnelSubset?.[subjectId]?.[subset] ?? [],
            ),
        }
      : undefined,
    parameterRule: provided(data, 'parameterRule')
      ? {
          value: (subjectId, parameters) =>
            inMemoryOutcome(
              'parameterRule',
              data,
              subjectId,
              () => data.parameterRule?.(subjectId, parameters) ?? null,
            ),
        }
      : undefined,
  };
}

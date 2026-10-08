/**
 * 计算上下文（REQ-EXP-001）：“今天”与时区由调用方传入（DEC-056），引擎不读系统时钟；取数走端口。
 */
import type { IsoDate } from '../tenant-time.js';
import type { RankingTables } from './functions/ranking.js';
import type { DataSourcePorts, SubjectReader } from './ports.js';
import type { FunctionRegistry } from './registry.js';
import type { ExpressionSemantics } from './semantics.js';
import type { ExpressionFieldKind } from './values.js';

export interface EvaluationCalendar {
  /** 租户时区下的业务日期“今天”（YYYY-MM-DD）。 */
  readonly today: IsoDate;
  /** IANA 时区名，用于把端口给的 Date 瞬时换算成业务日期。 */
  readonly timeZone: string;
  /**
   * 当前时刻（UTC 瞬时），Now() 按租户时区换算成墙上时间（DEC-056 / DEC-265）；不传时 Now() 计算失败。
   * 传入时在租户时区下须与“今天”同一天。
   */
  readonly now?: Date;
}

/** 盘点项目时间（UTC 瞬时），供“最近一次”取数函数划界。 */
export interface ProjectWindow {
  readonly startAt?: Date;
  readonly endAt?: Date;
}

/**
 * 测评取数“最近一次”的时间口径（DEC-031）：默认盘点项目结束时间前，可改为开始时间前。
 * 只作用于 LastestAssessmentCent；360 固定取项目结束时间前已结束、报告已生成的最近一次活动（DEC-262②）。
 */
export type AssessmentLatestWindow = 'before_project_end' | 'before_project_start';

export interface EvaluationContext {
  readonly subject: SubjectReader;
  readonly calendar: EvaluationCalendar;
  readonly project?: ProjectWindow;
  readonly assessmentLatestWindow?: AssessmentLatestWindow;
  readonly ports?: DataSourcePorts;
  readonly registry?: FunctionRegistry;
  readonly semantics?: ExpressionSemantics;
  /**
   * 字段类型目录（同保存校验的 ValidationOptions.fieldKind）：公式文本求值前的静态检查、函数参数的类型推导，
   * 以及字段为空时的来源类型都按它（DEC-287）；使用方应与保存时传入同一目录。
   */
  readonly fieldKind?: (path: string) => ExpressionFieldKind | undefined;
  /**
   * 排名表缓存（DEC-301② 排名在全体总体上一次性求值）：同一总体、同一上下文的多个对象共用，同一排名调用只算一次。
   * evaluateBatch 为每个计算项目自建；单独调用 evaluateFormula 时不传则每次现算。
   */
  readonly rankingTables?: RankingTables;
}

/** 批量求值的公共上下文：对象逐个注入。 */
export type BatchContext = Omit<EvaluationContext, 'subject'>;

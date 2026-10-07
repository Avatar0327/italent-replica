/**
 * 统一表达式引擎与北森函数库（R3-T00，REQ-EXP-001，DEC-024）。纯函数、无 I/O；取数经端口注入。
 */
export type {
  ArithmeticOperator,
  BinaryOperator,
  CallNode,
  ComparisonOperator,
  Definition,
  ExprNode,
  FieldNode,
  IfBranch,
  IfNode,
  Program,
} from './ast.js';
export { walk, walkProgram } from './ast.js';
export type {
  AssessmentLatestWindow,
  BatchContext,
  EvaluationCalendar,
  EvaluationContext,
  ProjectWindow,
} from './context.js';
export { dateAdd, dateDiff, formatDate, instantToParts, parseDateText, type DateUnit } from './dates.js';
export {
  evaluateBatch,
  evaluateFormula,
  orderComputationItems,
  validateFormula,
  type BatchResult,
  type ComputationItem,
  type EvaluationResult,
  type FieldBindings,
  type OrderedItem,
  type OrderingFailure,
  type OrderingResult,
  type ValidationOptions,
  type ValidationResult,
} from './engine.js';
export {
  CONVERSION_MESSAGE,
  FAILURE_CODES,
  FAILURE_PREFIX,
  PARSER_MESSAGE,
  type ComputationFailure,
  type FailureCode,
  type SourcePosition,
} from './failures.js';
export {
  ASSESSMENT_OBJECTS,
  BUILTIN_FUNCTIONS,
  PERFORMANCE_FIELDS,
  RECORD_OBJECTS,
  SURVEY360_OBJECT,
} from './functions/index.js';
export {
  tokenize,
  type SyntaxIssue,
  type SyntaxIssueCode,
  type Token,
  type TokenizeOptions,
  type TokenKind,
} from './lexer.js';
export { parseFormula, type ParseResult } from './parser.js';
export {
  createInMemoryPorts,
  inMemorySubject,
  plainToValue,
  type AssessmentPort,
  type AssessmentRecord,
  type DataSourcePorts,
  type FieldLookup,
  type InMemoryPortData,
  type InMemoryRankingMember,
  type InMemorySubjectOptions,
  type PerformancePort,
  type PerformanceRecord,
  type PortName,
  type PortOutcome,
  type RankingPort,
  type ReviewJudge,
  type ReviewModule,
  type ReviewPort,
  type SubjectReader,
  type Survey360Port,
  type Survey360Record,
} from './ports.js';
export {
  arityOf,
  createDefaultRegistry,
  FunctionRegistry,
  type FunctionCall,
  type FunctionEnvironment,
  type FunctionParam,
  type FunctionSpec,
} from './registry.js';
export { DEFAULT_SEMANTICS, type ExpressionSemantics } from './semantics.js';
export {
  describeValue,
  EMPTY,
  formatIsoLike,
  isOptionValue,
  KIND_LABELS,
  type DateParts,
  type DatePrecision,
  type ExprValue,
  type ExprValueKind,
  type OptionValue,
  type PlainValue,
} from './values.js';

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
export { childrenOf, walk, walkProgram } from './ast.js';
export type {
  AssessmentLatestWindow,
  BatchContext,
  EvaluationCalendar,
  EvaluationContext,
  ProjectWindow,
} from './context.js';
export { addMinutes, dateAdd, dateDiff, formatDate, instantToParts, parseDateText, type DateUnit } from './dates.js';
export {
  evaluateBatch,
  evaluateFormula,
  orderComputationItems,
  validateFormula,
  type BatchEvaluationHooks,
  type BatchResult,
  type ComputationItem,
  type EvaluationResult,
  type FieldBindings,
  type OrderedItem,
  type OrderingFailure,
  type OrderingResult,
  type ValidationOptions,
  type ValidationResult,
  type ValidationWarning,
} from './engine.js';
export {
  CONVERSION_MESSAGE,
  FAILURE_CODES,
  FAILURE_PREFIX,
  HYPHEN_SUBTRACTION_HINT,
  PARSER_MESSAGE,
  type ComputationFailure,
  type FailureCode,
  type SourcePosition,
} from './failures.js';
export {
  ASSESSMENT_OBJECTS,
  BUILTIN_FUNCTIONS,
  FUNCTION_PANEL,
  PERFORMANCE_FIELDS,
  SURVEY360_OBJECT,
  TALENT_REVIEW_OBJECT,
  type PanelCategory,
  type PanelEntry,
} from './functions/index.js';
export { tokenize, type SyntaxIssue, type SyntaxIssueCode, type Token, type TokenKind } from './lexer.js';
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
  type ParameterRulePort,
  type PerformancePort,
  type PerformanceRecord,
  type PersonnelSubsetPort,
  type PersonnelSubsetRecord,
  type PortName,
  type PortOutcome,
  type RankingPort,
  type ReviewJudge,
  type ReviewModule,
  type ReviewPort,
  type SubjectReader,
  type Survey360Port,
  type Survey360Record,
  type TalentReviewPort,
  type TalentReviewRecord,
} from './ports.js';
export {
  arityOf,
  createDefaultRegistry,
  FunctionRegistry,
  type ArgumentIssue,
  type FunctionCall,
  type FunctionEnvironment,
  type FunctionParam,
  type FunctionSpec,
  type StaticKind,
} from './registry.js';
export { DEFAULT_SEMANTICS, type ExpressionSemantics } from './semantics.js';
export {
  declaredType,
  isDefinitely,
  mayBe,
  mergeTypes,
  TypeInference,
  verdictFor,
  type InferredType,
  type TypeInferenceOptions,
} from './typing.js';
export {
  describeValue,
  EMPTY,
  emptyOf,
  formatIsoLike,
  isOptionValue,
  KIND_LABELS,
  type DateParts,
  type DatePrecision,
  type ExprValue,
  type ExprValueKind,
  type ExpressionFieldKind,
  type OptionValue,
  type PlainValue,
} from './values.js';

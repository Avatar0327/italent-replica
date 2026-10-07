/**
 * 语法树（REQ-EXP-001）：求值与解析分离；每个节点带源位置，便于保存时报错与计算失败定位。
 */
import type { SourcePosition } from './failures.js';

export type ComparisonOperator = '=' | '!=' | '<' | '>' | '<=' | '>=';
export type ArithmeticOperator = '+' | '-' | '*' | '/';
export type BinaryOperator = ComparisonOperator | ArithmeticOperator;

export interface NodeBase {
  readonly pos: SourcePosition;
}

export interface NumberNode extends NodeBase {
  readonly type: 'number';
  readonly value: number;
  readonly percent: boolean;
}

export interface StringNode extends NodeBase {
  readonly type: 'string';
  readonly value: string;
}

export interface BooleanNode extends NodeBase {
  readonly type: 'boolean';
  readonly value: boolean;
}

/** 变量或不带对象前缀的字段名。 */
export interface IdentifierNode extends NodeBase {
  readonly type: 'identifier';
  readonly name: string;
}

/** 字段引用，如 考核结果.年度；path 为各段名字，text 为用“.”拼回的完整路径。 */
export interface FieldNode extends NodeBase {
  readonly type: 'field';
  readonly path: readonly string[];
  readonly text: string;
}

export interface UnaryNode extends NodeBase {
  readonly type: 'unary';
  readonly operator: '-' | '+';
  readonly operand: ExprNode;
}

export interface BinaryNode extends NodeBase {
  readonly type: 'binary';
  readonly operator: BinaryOperator;
  readonly left: ExprNode;
  readonly right: ExprNode;
}

export type LogicalNode = NodeBase &
  (
    | { readonly type: 'logical'; readonly operator: 'and' | 'or'; readonly left: ExprNode; readonly right: ExprNode }
    | { readonly type: 'logical'; readonly operator: 'not'; readonly operand: ExprNode }
  );

export interface IfBranch {
  readonly condition: ExprNode;
  readonly then: ExprNode;
}

export interface IfNode extends NodeBase {
  readonly type: 'if';
  readonly branches: readonly IfBranch[];
  readonly otherwise?: ExprNode;
}

export interface CallNode extends NodeBase {
  readonly type: 'call';
  /** 公式里写的名字（中文或英文）。 */
  readonly name: string;
  readonly args: readonly ExprNode[];
}

export type ExprNode =
  | NumberNode
  | StringNode
  | BooleanNode
  | IdentifierNode
  | FieldNode
  | UnaryNode
  | BinaryNode
  | LogicalNode
  | IfNode
  | CallNode;

/** Def(变量, 表达式); */
export interface Definition extends NodeBase {
  readonly name: string;
  readonly value: ExprNode;
}

export interface Program {
  readonly definitions: readonly Definition[];
  readonly body: ExprNode;
}

/** 直接子节点（按源码顺序），供遍历与静态检查。 */
export function childrenOf(node: ExprNode): readonly ExprNode[] {
  switch (node.type) {
    case 'unary':
      return [node.operand];
    case 'binary':
      return [node.left, node.right];
    case 'logical':
      return node.operator === 'not' ? [node.operand] : [node.left, node.right];
    case 'if': {
      const branches = node.branches.flatMap((branch) => [branch.condition, branch.then]);
      return node.otherwise ? [...branches, node.otherwise] : branches;
    }
    case 'call':
      return node.args;
    default:
      return [];
  }
}

/** 深度优先遍历，供依赖分析与校验。 */
export function walk(node: ExprNode, visit: (node: ExprNode) => void): void {
  visit(node);
  for (const child of childrenOf(node)) walk(child, visit);
}

export function walkProgram(program: Program, visit: (node: ExprNode) => void): void {
  for (const definition of program.definitions) walk(definition.value, visit);
  walk(program.body, visit);
}

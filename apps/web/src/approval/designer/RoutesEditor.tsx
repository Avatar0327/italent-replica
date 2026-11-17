import { Button, Form, Input, InputNumber, Select, Space } from 'antd';
import {
  APPROVAL_TYPES,
  CONDITION_OPERATORS,
  MAX_ROUTE_BRANCHES,
  MAX_ROUTE_CONDITION_ITEMS,
  ROUTE_END,
  nodeExits,
  type ApprovalNode,
  type ConditionField,
  type ConditionItem,
  type ExitRoute,
  type RouteBranch,
} from '@italent/domain';
import { useFormLock } from '../../foundation/forms/FormLock.js';
import type { Located } from './locate.js';
import { m } from './messages.js';
import { nodeField } from './model.js';
import { r } from './route-messages.js';
import { EMPTY_OPERATORS, LIST_OPERATORS, exitLabel } from './routes.js';

type Option = { value: string; label: string };
type Operator = ConditionItem['operator'];
// 编辑中尚未选择的运算符；保存前由 routesInputError 拦截，不会提交。
const UNSELECTED = '' as Operator;
interface Scope {
  readonly targets: readonly Option[];
  readonly fields: readonly ConditionField[];
  readonly disabled: boolean;
}

/** F-478 S7 节点出口分支编辑（设计 §1.4）：每个出口一组，分支顺序即服务端 branchNo；保存走整份草稿。 */
export function RoutesEditor(props: {
  node: ApprovalNode;
  nodes: readonly ApprovalNode[];
  approvalType: string;
  located?: Located;
}) {
  return (
    <Form.Item name={nodeField(props.node.key, 'routes')} noStyle>
      <RoutesValue {...props} />
    </Form.Item>
  );
}

function RoutesValue({
  node,
  nodes,
  approvalType,
  located,
  value,
  onChange,
}: {
  node: ApprovalNode;
  nodes: readonly ApprovalNode[];
  approvalType: string;
  located?: Located;
  value?: unknown;
  onChange?: (value: ExitRoute[]) => void;
}) {
  const lock = useFormLock();
  const change = lock.guard((next: ExitRoute[]) => onChange?.(next));
  const routes = Array.isArray(value) ? (value as ExitRoute[]) : [];
  const exits = [...new Set([...nodeExits(node), ...routes.map((route) => route.exit)])];
  const position = nodes.findIndex((item) => item.key === node.key);
  const scope: Scope = {
    targets: [
      ...nodes.slice(position + 1).map((item) => ({ value: item.key, label: item.name })),
      { value: ROUTE_END, label: r.end },
    ],
    fields: APPROVAL_TYPES[approvalType as keyof typeof APPROVAL_TYPES]?.conditionFields ?? [],
    disabled: lock.disabled,
  };
  const here = located?.area === 'routes' && located.nodeKey === node.key ? located : undefined;
  return (
    <div className="flow-routes">
      <h4>{r.title}</h4>
      <p className="flow-muted">{r.hint}</p>
      {exits.map((exit) => (
        <ExitRoutes
          key={exit}
          exit={exit}
          branches={routes.find((route) => route.exit === exit)?.branches ?? []}
          scope={scope}
          locatedBranch={here?.exit === exit ? here.branchNo : undefined}
          onChange={(branches) => change(withExit(routes, exit, branches))}
        />
      ))}
    </div>
  );
}
/** 出口没有分支时整条移除：服务端要求每个出口至少一个分支，全空时显式提交 []。 */
function withExit(routes: readonly ExitRoute[], exit: string, branches: RouteBranch[]): ExitRoute[] {
  if (!branches.length) return routes.filter((route) => route.exit !== exit);
  if (!routes.some((route) => route.exit === exit)) return [...routes, { exit, branches }];
  return routes.map((route) => (route.exit === exit ? { exit, branches } : route));
}
const conditionBranch = (branches: readonly RouteBranch[]): RouteBranch => ({
  kind: 'condition',
  priority: Math.max(0, ...branches.map((branch) => branch.priority ?? 0)) + 1,
  conditions: { expression: '', items: [] },
  target: '',
});
// 条件分支插在 Else 之前，界面顺序与服务端判定顺序一致。
function addCondition(branches: readonly RouteBranch[]) {
  const others = branches.filter((branch) => branch.kind !== 'else');
  return [...others, conditionBranch(branches), ...branches.filter((branch) => branch.kind === 'else')];
}

function ExitRoutes({
  exit,
  branches,
  scope,
  locatedBranch,
  onChange,
}: {
  exit: string;
  branches: readonly RouteBranch[];
  scope: Scope;
  locatedBranch?: number;
  onChange(branches: RouteBranch[]): void;
}) {
  const full = branches.length >= MAX_ROUTE_BRANCHES;
  const direct = branches.some((branch) => branch.kind === 'direct');
  const otherwise = branches.some((branch) => branch.kind === 'else');
  const label = r.group(exitLabel(exit));
  return (
    <section role="group" aria-label={label} className="flow-route-group">
      <strong>{label}</strong>
      {!branches.length && <p className="flow-muted">{r.none}</p>}
      {branches.map((branch, index) => (
        <BranchEditor
          key={index}
          no={index + 1}
          branch={branch}
          scope={scope}
          located={locatedBranch === index + 1}
          onChange={(next) => onChange(branches.map((item, at) => (at === index ? next : item)))}
          onRemove={() => onChange(branches.filter((_, at) => at !== index))}
        />
      ))}
      <Space wrap>
        <Button disabled={scope.disabled || full || direct} onClick={() => onChange(addCondition(branches))}>
          {r.addCondition}
        </Button>
        <Button
          disabled={scope.disabled || full || direct || otherwise}
          onClick={() => onChange([...branches, { kind: 'else', target: '' }])}
        >
          {r.addElse}
        </Button>
        <Button
          disabled={scope.disabled || branches.length > 0}
          onClick={() => onChange([{ kind: 'direct', target: '' }])}
        >
          {r.addDirect}
        </Button>
      </Space>
    </section>
  );
}

function BranchEditor({
  no,
  branch,
  scope,
  located,
  onChange,
  onRemove,
}: {
  no: number;
  branch: RouteBranch;
  scope: Scope;
  located: boolean;
  onChange(branch: RouteBranch): void;
  onRemove(): void;
}) {
  const condition = branch.kind === 'condition';
  return (
    <section
      role="group"
      aria-label={r.branch(no)}
      className={located ? 'flow-route-branch flow-route-located' : 'flow-route-branch'}
    >
      <div className="flow-route-row">
        <span>{`${r.branch(no)} · ${r.kinds[branch.kind] ?? branch.kind}`}</span>
        {condition && <span>{r.priority}</span>}
        {condition && (
          <InputNumber
            aria-label={r.priority}
            min={1}
            max={32767}
            precision={0}
            disabled={scope.disabled}
            value={branch.priority}
            onChange={(priority) => onChange({ ...branch, priority: priority ?? undefined })}
          />
        )}
        <Button disabled={scope.disabled} onClick={onRemove}>
          {r.removeBranch}
        </Button>
      </div>
      {condition && <ConditionItems branch={branch} scope={scope} onChange={onChange} />}
      <div className="flow-route-row">
        <span>{r.target}</span>
        <Select
          aria-label={r.target}
          className="flow-route-target"
          options={[...scope.targets]}
          disabled={scope.disabled}
          value={branch.target || undefined}
          onChange={(target: string) => onChange({ ...branch, target })}
        />
      </div>
    </section>
  );
}

function ConditionItems({
  branch,
  scope,
  onChange,
}: {
  branch: RouteBranch;
  scope: Scope;
  onChange(branch: RouteBranch): void;
}) {
  const conditions = branch.conditions ?? { expression: '', items: [] };
  const update = (next: Partial<typeof conditions>) => onChange({ ...branch, conditions: { ...conditions, ...next } });
  const items = conditions.items;
  const no = Math.max(0, ...items.map((item) => item.no)) + 1;
  return (
    <>
      {items.map((item, index) => (
        <ItemRow
          key={item.no}
          item={item}
          scope={scope}
          onChange={(next) => update({ items: items.map((entry, at) => (at === index ? next : entry)) })}
          onRemove={() => update({ items: items.filter((_, at) => at !== index) })}
        />
      ))}
      <div className="flow-route-row">
        <Button
          disabled={scope.disabled || items.length >= MAX_ROUTE_CONDITION_ITEMS}
          onClick={() => update({ items: [...items, { no, field: '', operator: UNSELECTED, value: '' }] })}
        >
          {r.addItem}
        </Button>
        <span>{r.expression}</span>
        <Input
          aria-label={r.expression}
          className="flow-route-expression"
          placeholder={r.expressionHint}
          disabled={scope.disabled}
          value={conditions.expression}
          onChange={(event) => update({ expression: event.target.value })}
        />
      </div>
    </>
  );
}

function ItemRow({
  item,
  scope,
  onChange,
  onRemove,
}: {
  item: ConditionItem;
  scope: Scope;
  onChange(item: ConditionItem): void;
  onRemove(): void;
}) {
  const field = scope.fields.find((entry) => entry.path === item.field);
  // 属于组织树只对组织字段开放（conditions.ts 同口径），其余运算符对全部字段可选。
  const operators = CONDITION_OPERATORS.filter((operator) => operator !== 'in_org_tree' || field?.kind === 'org');
  const reset = (operator: string) =>
    LIST_OPERATORS.includes(operator) ? [] : EMPTY_OPERATORS.includes(operator) ? null : '';
  return (
    <div role="group" aria-label={r.item(item.no)} className="flow-route-row flow-route-item">
      <span>{r.item(item.no)}</span>
      <Select
        aria-label={r.field}
        className="flow-route-field"
        disabled={scope.disabled}
        value={item.field || undefined}
        options={scope.fields.map((entry) => ({ value: entry.path, label: entry.label }))}
        onChange={(path: string) => onChange({ ...item, field: path, operator: UNSELECTED, value: '' })}
      />
      <Select
        aria-label={r.operator}
        className="flow-route-operator"
        disabled={scope.disabled || !item.field}
        value={item.operator || undefined}
        options={operators.map((operator) => ({ value: operator, label: m.values[operator] ?? operator }))}
        onChange={(operator: Operator) => onChange({ ...item, operator, value: reset(operator) })}
      />
      <ItemValue item={item} disabled={scope.disabled} onChange={(value) => onChange({ ...item, value })} />
      <Button disabled={scope.disabled} onClick={onRemove}>
        {r.removeItem}
      </Button>
    </div>
  );
}

function ItemValue({
  item,
  disabled,
  onChange,
}: {
  item: ConditionItem;
  disabled: boolean;
  onChange(value: ConditionItem['value']): void;
}) {
  if (!item.operator || EMPTY_OPERATORS.includes(item.operator))
    return <span className="flow-muted flow-route-value">{item.operator ? r.noValue : ''}</span>;
  if (LIST_OPERATORS.includes(item.operator))
    return (
      <Select
        mode="tags"
        aria-label={r.value}
        className="flow-route-value"
        placeholder={r.listHint}
        disabled={disabled}
        open={false}
        value={Array.isArray(item.value) ? item.value : []}
        onChange={(values: string[]) => onChange(values.map((value) => value.trim()).filter(Boolean))}
      />
    );
  return (
    <Input
      aria-label={r.value}
      className="flow-route-value"
      disabled={disabled}
      value={typeof item.value === 'string' ? item.value : ''}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

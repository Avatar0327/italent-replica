import { Form, TreeSelect, type TreeSelectProps } from 'antd';
import { text } from './messages.js';
import { BASE } from '../org/api.js';
import { type ServerOrgNode, type ServerOrgTree } from '../org/page-model.js';
import { useRemote } from '../org/page-support.js';
import { display } from './model.js';

type Node = NonNullable<TreeSelectProps['treeData']>[number];

function choices(roots: ServerOrgNode[]): Node[] {
  return roots.flatMap((row) => {
    const children = choices(row.children);
    return row.id ? [{ value: row.id, title: display(row.name), children }] : children;
  });
}
interface Props {
  label: string;
  asOf?: string;
  multiple?: boolean;
  includeDisabled?: boolean;
  value?: string | string[] | null;
  onChange?(value: string | string[] | undefined): void;
  disabled?: boolean;
  id?: string;
  selected?: { id: string; name?: string | null }[];
}

export function OrgChoice({ label, asOf, selected = [], value, onChange, includeDisabled, ...props }: Props) {
  const query = new URLSearchParams({
    ...(asOf && { asOf }),
    ...(includeDisabled && { includeDisabled: 'true' }),
  });
  const tree = useRemote<ServerOrgTree>(`${BASE}/tree?${query}`);
  const nodes = choices(tree.data?.roots ?? []);
  const ids = new Set<string>();
  const collect = (items: Node[]) =>
    items.forEach((item) => {
      if (typeof item.value === 'string') ids.add(item.value);
      collect(item.children ?? []);
    });
  collect(nodes);
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const retained = values
    .filter((id) => !ids.has(id))
    .map((id) => ({ value: id, title: display(selected.find((item) => item.id === id)?.name) }));
  return (
    <TreeSelect
      {...props}
      value={value ?? undefined}
      onChange={(next) => onChange?.(next ?? (props.multiple ? [] : undefined))}
      style={{ minWidth: 165 }}
      aria-label={label}
      placeholder={label}
      treeData={[...nodes, ...retained]}
      loading={tree.loading}
      status={tree.error ? 'error' : undefined}
      notFoundContent={tree.error ? text.orgError : text.orgEmpty}
      treeNodeFilterProp="title"
      showSearch
      allowClear
    />
  );
}

export function FormOrgChoice(props: Props) {
  const date = Form.useWatch<string | null>('effectiveDate');
  return <OrgChoice {...props} asOf={date ?? props.asOf} />;
}

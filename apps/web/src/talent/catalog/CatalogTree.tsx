import { Button, Input, Tree } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { ApiError } from '../../foundation/client.js';
import { PageState } from '../../foundation/PageState.js';
import { candidates } from './api.js';
import { useRemote } from './hooks.js';
import { m } from './messages.js';
import type { Resource, Row } from './types.js';

function nodes(rows: Row[], parent: string | null = null, seen = new Set<string>()): DataNode[] {
  return rows
    .filter(
      (row) =>
        ((row.parentId ?? null) === parent || (parent === null && !rows.some((item) => item.id === row.parentId))) &&
        !seen.has(row.id),
    )
    .map((row) => ({
      key: row.id,
      title: row.name ?? m.unknown,
      children: nodes(rows, row.id, new Set([...seen, row.id])),
    }));
}
/** 类别按已验证的分类选择查询；标准与指标树的筛选行为无契约/未验证，仅展示真实可读分类。 */
export function CatalogTree({
  resource,
  selected,
  onSelect,
}: {
  resource: Resource;
  selected: string;
  onSelect(id: string): void;
}) {
  const target = resource.key === 'targets';
  const state = useRemote(`tree:${resource.key}`, async (api, signal) => {
    try {
      return await candidates(api, `/api/tenant/qualification/${target ? 'target-types' : 'category-classes'}`, signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) return [];
      throw error;
    }
  });
  const rows = state.data ?? [];
  const tree = nodes(rows);
  return (
    <aside className="catalog-tree">
      <h2>{target ? m.targetType : m.categoryClass}</h2>
      <Input aria-label={m.treeSearch} placeholder={m.treeSearch} disabled />
      {state.error ? (
        <PageState kind="error" error={state.error} />
      ) : (
        <Tree
          treeData={[{ key: '', title: target ? m.allTargets : m.all }, ...tree]}
          selectedKeys={[selected]}
          selectable={resource.key === 'categories'}
          onSelect={(keys) => onSelect(String(keys[0] ?? ''))}
        />
      )}
      <Button disabled>{target ? m.create : m.setCategories}</Button>
    </aside>
  );
}

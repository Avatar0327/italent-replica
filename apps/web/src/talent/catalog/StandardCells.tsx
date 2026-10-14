import { Alert, Table } from 'antd';
import { ApiError } from '../../foundation/client.js';
import { PageState } from '../../foundation/PageState.js';
import { useRemote } from './hooks.js';
import { m } from './messages.js';

type Part = Record<string, unknown>;
const parts = (value: unknown): Part[] => (Array.isArray(value) ? value : []);
const valueText = (value: unknown) =>
  typeof value === 'number' || (typeof value === 'string' && value !== '') ? String(value) : m.unknown;

function useGradeNames(cells: Part[]) {
  const ids = [
    ...new Set(
      cells
        .filter((cell) => parts(cell.abilities).some((a) => a.targetGradeId))
        .map((cell) => cell.targetId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ].sort();
  return useRemote(ids.length ? `standard-grades:${ids.join(',')}` : '', async (api, signal) => {
    const names = await Promise.all(
      ids.map(async (id) => {
        try {
          const result = await api.request<{ items: { gradeDetailId: string; name?: string }[] }>(
            `/api/tenant/qualification/targets/${encodeURIComponent(id)}/grade-descriptions`,
            { signal },
          );
          return result.items
            .filter((grade) => typeof grade.name === 'string')
            .map((grade) => [grade.gradeDetailId, grade.name!] as const);
        } catch (error) {
          if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return [];
          throw error;
        }
      }),
    );
    return new Map(names.flat());
  });
}

/** 规格 23 §3：指标格与能力条目各自持有目标和权重，展开时保留两层，不以同名键合并。 */
export function StandardCells({ cells, names }: { cells: unknown; names?: Map<string, string> }) {
  const source = parts(cells);
  const grades = useGradeNames(source);
  const rows = source.flatMap((cell, i) => {
    const abilities = parts(cell.abilities);
    return (abilities.length ? abilities : [{}]).map((ability, j) => ({ cell, ability, key: `${i}:${j}` }));
  });
  const missingGrade =
    grades.data &&
    rows.some(({ ability }) => typeof ability.targetGradeId === 'string' && !grades.data?.has(ability.targetGradeId));
  return (
    <>
      {!!grades.error && <PageState kind="error" error={grades.error} />}
      {missingGrade && <Alert type="info" message={m.gradeNameUnavailable} />}
      <Table
        size="small"
        rowKey="key"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: m.target,
            dataIndex: ['cell', 'targetId'],
            render: (id: unknown) => valueText(names?.get(String(id)) ?? id),
          },
          { title: m.cellTarget, dataIndex: ['cell', 'targetValue'], render: valueText },
          { title: m.cellWeight, dataIndex: ['cell', 'weight'], render: valueText },
          { title: m.content, dataIndex: ['ability', 'content'], render: valueText },
          { title: m.abilityTarget, dataIndex: ['ability', 'targetValue'], render: valueText },
          {
            title: m.targetGrade,
            dataIndex: ['ability', 'targetGradeId'],
            render: (id: unknown) => valueText(grades.data?.get(String(id)) ?? id),
          },
          { title: m.abilityWeight, dataIndex: ['ability', 'weight'], render: valueText },
        ]}
      />
    </>
  );
}

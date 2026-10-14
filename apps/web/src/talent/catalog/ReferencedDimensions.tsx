import { InputNumber, Select, Table } from 'antd';
import type { Row } from './types.js';
import { m } from './messages.js';
interface Reference {
  dimensionId: string;
  weight?: number | null;
  target?: number | null;
}
export function ReferencedDimensions({
  id,
  value = [],
  onChange,
  rows,
}: {
  id?: string;
  value?: Reference[];
  onChange?: (value: Reference[]) => void;
  rows: Row[];
}) {
  const changeNumber = (dimensionId: string, key: 'weight' | 'target', number: number | null) =>
    onChange?.(value.map((item) => (item.dimensionId === dimensionId ? { ...item, [key]: number } : item)));
  return (
    <>
      <Select
        id={id}
        mode="multiple"
        showSearch
        optionFilterProp="label"
        value={value.map((item) => item.dimensionId)}
        options={rows.map((row) => ({ value: row.id, label: row.name ?? row.id }))}
        onChange={(ids: string[]) =>
          onChange?.(
            ids.map((dimensionId) => value.find((item) => item.dimensionId === dimensionId) ?? { dimensionId }),
          )
        }
      />
      <Table
        size="small"
        rowKey="dimensionId"
        pagination={false}
        dataSource={value}
        columns={[
          {
            title: m.name,
            render: (_, item) => rows.find((row) => row.id === item.dimensionId)?.name ?? item.dimensionId,
          },
          ...(['weight', 'target'] as const).map((key) => ({
            title: key === 'weight' ? m.weight : m.targetValue,
            render: (_: unknown, item: Reference) =>
              rows.find((row) => row.id === item.dimensionId)?.type === 'ability' ? (
                <InputNumber
                  precision={1}
                  value={item[key]}
                  onChange={(number) => changeNumber(item.dimensionId, key, number)}
                />
              ) : (
                m.unknown
              ),
          })),
        ]}
      />
    </>
  );
}

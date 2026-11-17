// 引用清单：查看引用弹窗与停用前影响清单共用（口径见设计 §6.1：草稿、当前已发布、在途旧版本，含空人候选）。
import { Modal, Table, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { rejectionMessage } from '../../foundation/client.js';
import { useApiClient } from '../../foundation/Session.js';
import { m } from './messages.js';
import {
  matrixPath,
  parseColumnNames,
  parseReferences,
  type MatrixHead,
  type MatrixReference,
  type MatrixReferences,
} from './model.js';

const version = (item: MatrixReference) => `${m.versionKind[item.versionKind] ?? '—'} v${item.versionNo}`;
const columns = [
  { title: m.processName, dataIndex: 'processName' },
  { title: m.processCode, dataIndex: 'processCode' },
  { title: m.version, key: 'version', render: (_: unknown, item: MatrixReference) => version(item) },
  { title: m.node, dataIndex: 'nodeName' },
  { title: m.roleColumn, dataIndex: 'columnName', render: (value?: string) => value ?? '—' },
  { title: m.position, dataIndex: 'position', render: (value: string) => m.positionLabel[value] ?? '—' },
  { title: m.instances, dataIndex: 'instanceCount', render: (value: number | null) => value ?? '—' },
];
// 同一节点可引用同一矩阵的多个角色列（会签），columnId 进行键，与后端排序键一致（source-usages.ts）。
const rowKey = (item: MatrixReference) =>
  [item.processCode, item.versionKind, item.versionNo, item.nodeKey, item.position, item.columnId].join('/');

export function ReferenceTable({ references }: { references: MatrixReferences }) {
  return (
    <>
      <Table
        size="small"
        pagination={false}
        rowKey={rowKey}
        dataSource={references.items}
        columns={columns}
        locale={{ emptyText: m.noReferences }}
      />
      {references.total > references.items.length && (
        <Typography.Text type="secondary">{m.truncated(references.total, references.items.length)}</Typography.Text>
      )}
    </>
  );
}

/** 读引用：每次打开都向服务端重读（停用前影响检查要拿当时的引用数）；角色列名取自同时读回的矩阵详情。 */
export async function readReferences(api: ReturnType<typeof useApiClient>, head: MatrixHead) {
  const [detail, raw] = await Promise.all([
    api.request<unknown>(matrixPath(head.id)),
    api.request<unknown>(matrixPath(head.id, 'references')),
  ]);
  const names = parseColumnNames(detail);
  const references = parseReferences(raw);
  const named = (item: MatrixReference) => (item.columnId ? names.get(item.columnId) : undefined);
  return { ...references, items: references.items.map((item) => ({ ...item, columnName: named(item) })) };
}

export function ReferencesDialog({ head, close }: { head: MatrixHead; close(): void }) {
  const api = useApiClient();
  const [state, setState] = useState<{ data?: MatrixReferences; error?: unknown }>({});
  useEffect(() => {
    let alive = true;
    readReferences(api, head).then(
      (data) => alive && setState({ data }),
      (error: unknown) => alive && setState({ error }),
    );
    return () => {
      alive = false;
    };
  }, [api, head]);
  return (
    <Modal open width={880} title={`${m.referencesTitle}：${head.name}`} footer={null} onCancel={close}>
      {state.data && <ReferenceTable references={state.data} />}
      {!!state.error && <Typography.Text type="danger">{rejectionMessage(state.error)}</Typography.Text>}
      {!state.data && !state.error && <Table size="small" loading columns={columns} dataSource={[]} />}
    </Modal>
  );
}

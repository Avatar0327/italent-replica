// 引用清单：查看引用弹窗与停用前影响清单共用（口径见设计 §6.1：草稿、当前已发布、在途旧版本，含空人候选）。
import { Modal, Table, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { rejectionMessage } from '../../foundation/client.js';
import { useApiClient } from '../../foundation/Session.js';
import { m } from './messages.js';
import { matrixPath, parseReferences, type MatrixHead, type MatrixReference, type MatrixReferences } from './model.js';

const version = (item: MatrixReference) => `${m.versionKind[item.versionKind] ?? '—'} v${item.versionNo}`;
const columns = [
  { title: m.processName, dataIndex: 'processName' },
  { title: m.processCode, dataIndex: 'processCode' },
  { title: m.version, key: 'version', render: (_: unknown, item: MatrixReference) => version(item) },
  { title: m.node, dataIndex: 'nodeName' },
  { title: m.position, dataIndex: 'position', render: (value: string) => m.positionLabel[value] ?? '—' },
  { title: m.instances, dataIndex: 'instanceCount', render: (value: number | null) => value ?? '—' },
];
const rowKey = (item: MatrixReference) =>
  [item.processCode, item.versionKind, item.versionNo, item.nodeKey, item.position].join('/');

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

/** 读引用：每次打开都向服务端重读（停用前影响检查要拿当时的引用数）。 */
export async function readReferences(api: ReturnType<typeof useApiClient>, head: MatrixHead) {
  return parseReferences(await api.request<unknown>(matrixPath(head.id, 'references')));
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

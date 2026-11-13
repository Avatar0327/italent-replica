// 查看引用流程与停用前影响确认（设计 §6）：清单来自 GET /variables/:id/references，口径含草稿、当前已发布、在途旧版本。
import { Alert, Button, Modal, Table } from 'antd';
import { useState, type ReactNode } from 'react';
import { APPROVAL_TYPES } from '@italent/domain';
import { useRead } from '../../contracts/useRead.js';
import { PageState } from '../../foundation/PageState.js';
import { m } from './messages.js';
import { parseReferences, referenceKey, rowPath, type Reference, type VariableRow } from './model.js';

const typeName = (code: string) => APPROVAL_TYPES[code as keyof typeof APPROVAL_TYPES]?.name ?? code;

export function ReferenceTable({ items }: { items: readonly Reference[] }) {
  return (
    <Table<Reference>
      size="small"
      rowKey={referenceKey}
      dataSource={[...items]}
      pagination={false}
      locale={{ emptyText: m.ref.empty }}
      columns={[
        {
          key: 'process',
          title: m.ref.process,
          render: (_: unknown, ref: Reference) => `${ref.processName}（${ref.processCode}）`,
        },
        { key: 'type', title: m.ref.approvalType, render: (_: unknown, ref: Reference) => typeName(ref.approvalType) },
        {
          key: 'version',
          title: m.ref.version,
          render: (_: unknown, ref: Reference) =>
            m.ref.versionNo(m.ref.kinds[ref.versionKind] ?? ref.versionKind, ref.versionNo),
        },
        { key: 'node', title: m.ref.node, render: (_: unknown, ref: Reference) => ref.nodeName || ref.nodeKey },
        {
          key: 'position',
          title: m.ref.position,
          render: (_: unknown, ref: Reference) => m.ref.positions[ref.position] ?? ref.position,
        },
        {
          key: 'instances',
          title: m.ref.instances,
          render: (_: unknown, ref: Reference) => (ref.instanceCount === null ? m.missing : ref.instanceCount),
        },
      ]}
    />
  );
}

/** ▾ 查看引用流程：只读弹窗。 */
export function ReferencesModal({ row, close }: { row: VariableRow; close(): void }) {
  const read = useRead<unknown>(rowPath(row.id, 'references'));
  let content: ReactNode = <PageState kind="loading" />;
  try {
    if (read.error) content = <PageState kind="error" error={read.error} retry={read.refresh} />;
    else if (read.data !== undefined) content = <ReferenceTable items={parseReferences(read.data).items} />;
  } catch (error) {
    content = <PageState kind="error" error={error} retry={read.refresh} />;
  }
  return (
    <Modal
      open
      width={880}
      title={m.referencesTitle(row.name)}
      onCancel={close}
      footer={<Button onClick={close}>{m.close}</Button>}
    >
      {content}
    </Modal>
  );
}

interface Impact {
  title: string;
  warning: string;
  plain: string;
  items: readonly Reference[];
  resolve(ok: boolean): void;
}
/**
 * 停用 / 去掉「流程」前的确认：有引用列出影响清单（设计 §6.2 原文），无引用为普通确认。
 * 弹窗只在等待确认时挂载，关掉即卸载；返回值 true 表示用户确认。
 */
export function useImpactConfirm() {
  const [impact, setImpact] = useState<Impact>();
  const ask = (input: Omit<Impact, 'resolve'>) =>
    new Promise<boolean>((resolve) =>
      setImpact({
        ...input,
        resolve: (ok) => {
          setImpact(undefined);
          resolve(ok);
        },
      }),
    );
  const holder = impact && (
    <Modal
      open
      width={impact.items.length ? 880 : 420}
      title={impact.title}
      okText={m.confirm}
      cancelText={m.cancel}
      onOk={() => impact.resolve(true)}
      onCancel={() => impact.resolve(false)}
    >
      {impact.items.length ? (
        <>
          <Alert type="warning" showIcon message={impact.warning} />
          <ReferenceTable items={impact.items} />
        </>
      ) : (
        impact.plain
      )}
    </Modal>
  );
  return { ask, holder };
}

// 企业设置 › 流程矩阵（F-326 F2a）：左侧矩阵列表（启用的 / 停用的、关键字、翻页、底部新建），右侧选中矩阵的头部与操作。
// 结构（条件列、角色列、数据行）的编辑归 F2b，本页不展示。
import { Button, Descriptions, Empty, Input, Space, Table, Tabs, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useRead } from '../../contracts/useRead.js';
import { PageState } from '../../foundation/PageState.js';
import { FormCommands } from '../../foundation/forms/useCommandForm.js';
import { matrixStore } from './commands.js';
import { HeadForm } from './HeadForm.js';
import { m } from './messages.js';
import { PAGE_SIZE, listPath, parseList, type MatrixHead, type MatrixStatus, type View } from './model.js';
import { StatusActions } from './StatusActions.js';
import './matrix.css';

const statusColor: Record<string, string> = { enabled: 'green', draft: 'default', disabled: 'red' };
const statusTag = (status: string) => <Tag color={statusColor[status]}>{m.statusLabel[status]}</Tag>;
const columns = [
  { title: m.name, dataIndex: 'name', ellipsis: true },
  { title: m.code, dataIndex: 'code', ellipsis: true },
  { title: m.status, dataIndex: 'status', width: 72, render: statusTag },
];

function useMatrices() {
  const [view, setView] = useState<View>('active');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const read = useRead<unknown>(listPath(view, q, offset));
  let page: ReturnType<typeof parseList> | undefined;
  let error = read.error;
  try {
    page = read.data === undefined ? undefined : parseList(read.data);
  } catch (cause) {
    error = cause;
  }
  const show = (next: View) => {
    setView(next);
    setOffset(0);
  };
  return { view, show, q, setQ, offset, setOffset, page, error, loading: read.loading, refresh: read.refresh };
}

export function MatrixPage({ editable }: { editable: boolean }) {
  return (
    <FormCommands store={matrixStore}>
      <Matrices editable={editable} />
    </FormCommands>
  );
}

type Saved = (receipt?: { id: string; status: MatrixStatus }) => void;
type Matrices = ReturnType<typeof useMatrices>;

function Matrices({ editable }: { editable: boolean }) {
  const list = useMatrices();
  const [selected, setSelected] = useState<string>();
  const [form, setForm] = useState<{ head?: MatrixHead }>();
  const items = list.page?.items ?? [];
  const head = items.find((item) => item.id === selected) ?? items[0];
  // 写成功后按回执状态切到所在页签并选中；结果未明或被拒时只刷新（回查）。
  const saved: Saved = (receipt) => {
    if (receipt) {
      setSelected(receipt.id);
      const view: View = receipt.status === 'disabled' ? 'disabled' : 'active';
      if (view !== list.view) return list.show(view);
    }
    list.refresh();
  };
  return (
    <div className="matrix-page">
      <MatrixList
        list={list}
        selected={head?.id}
        select={setSelected}
        create={editable ? () => setForm({}) : undefined}
      />
      <section className="matrix-head">
        {head && <HeadPanel head={head} editable={editable} edit={() => setForm({ head })} saved={saved} />}
        {!head && !list.loading && <Empty description={m.pick} />}
      </section>
      {form && <HeadForm head={form.head} close={() => setForm(undefined)} saved={saved} />}
    </div>
  );
}

function MatrixList(props: { list: Matrices; selected?: string; select(id: string): void; create?: () => void }) {
  const { list, selected, select, create } = props;
  return (
    <section className="matrix-list">
      <Tabs
        activeKey={list.view}
        onChange={(key) => list.show(key as View)}
        items={[
          { key: 'active', label: m.active },
          { key: 'disabled', label: m.disabled },
        ]}
      />
      <Input.Search
        allowClear
        placeholder={m.search}
        maxLength={100}
        onSearch={(value) => {
          list.setQ(value.trim());
          list.setOffset(0);
        }}
      />
      {!!list.error && <PageState kind="error" error={list.error} retry={list.refresh} />}
      {!list.error && (
        <Table
          size="small"
          rowKey="id"
          loading={list.loading}
          pagination={false}
          dataSource={list.page?.items ?? []}
          columns={columns}
          locale={{ emptyText: m.empty }}
          rowClassName={(item) => (item.id === selected ? 'matrix-selected' : '')}
          onRow={(item) => ({ onClick: () => select(item.id) })}
        />
      )}
      <Space className="matrix-pager">
        <Button disabled={!list.offset} onClick={() => list.setOffset(Math.max(0, list.offset - PAGE_SIZE))}>
          {m.prev}
        </Button>
        <Button disabled={!list.page?.hasMore} onClick={() => list.setOffset(list.offset + PAGE_SIZE)}>
          {m.next}
        </Button>
      </Space>
      {create && (
        <Button type="dashed" block onClick={create}>
          {m.create}
        </Button>
      )}
    </section>
  );
}

function HeadPanel(props: { head: MatrixHead; editable: boolean; edit(): void; saved: Saved }) {
  const { head } = props;
  return (
    <>
      <Typography.Title level={4}>{head.name}</Typography.Title>
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label={m.name}>{head.name}</Descriptions.Item>
        <Descriptions.Item label={m.code}>{head.code}</Descriptions.Item>
        <Descriptions.Item label={m.status}>{statusTag(head.status)}</Descriptions.Item>
        <Descriptions.Item label={m.description}>
          <span className="matrix-description">{head.description ?? '—'}</span>
        </Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary">{m.structureLater}</Typography.Paragraph>
      <StatusActions key={`${head.id}@${head.revision}`} {...props} />
    </>
  );
}

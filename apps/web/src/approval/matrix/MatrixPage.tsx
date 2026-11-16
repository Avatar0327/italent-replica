// 企业设置 › 流程矩阵（F-326 F2a / F2b）：左侧矩阵列表（启用的 / 停用的、关键字、翻页、底部新建），
// 右侧选中矩阵的头部、操作与结构（条件列、角色列、数据行，StructureEditor）。
import { Button, Descriptions, Empty, Input, Space, Table, Tabs, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useRead } from '../../contracts/useRead.js';
import { PageState } from '../../foundation/PageState.js';
import { FormCommands } from '../../foundation/forms/useCommandForm.js';
import { matrixStore } from './commands.js';
import { HeadForm } from './HeadForm.js';
import { m } from './messages.js';
import {
  PAGE_SIZE,
  listPath,
  matrixPath,
  parseHead,
  parseList,
  type MatrixHead,
  type MatrixStatus,
  type View,
} from './model.js';
import { StatusActions } from './StatusActions.js';
import { StructureEditor } from './StructureEditor.js';
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
  // 保存后要定位的回执对象（可能不在当前筛选 / 当前页）；用户自己切页签、搜索、翻页即放开。
  const [pinned, setPinned] = useState<string>();
  const read = useRead<unknown>(listPath(view, q, offset));
  let page: ReturnType<typeof parseList> | undefined;
  let error = read.error;
  try {
    page = read.data === undefined ? undefined : parseList(read.data);
  } catch (cause) {
    error = cause;
  }
  const move = (next: { view?: View; q?: string; offset: number }) => {
    if (next.view) setView(next.view);
    if (next.q !== undefined) setQ(next.q);
    setOffset(next.offset);
    setPinned(undefined);
  };
  return {
    view,
    offset,
    page,
    error,
    loading: read.loading,
    refresh: read.refresh,
    pinned,
    pin: setPinned,
    show: (next: View) => move({ view: next, offset: 0 }),
    search: (next: string) => move({ q: next, offset: 0 }),
    turn: (next: number) => move({ offset: next }),
  };
}

/**
 * 右侧展示的矩阵：当前页里选中的那条，没有选中时取第一条。
 * 保存后的回执对象不在当前页时单独读详情；读取失败或响应无效时报错并给重试，不回退到其他矩阵。
 */
function useShown(list: ReturnType<typeof useMatrices>, selected?: string) {
  const items = list.page?.items ?? [];
  const inPage = items.find((item) => item.id === selected);
  const outside = list.page && !inPage && selected && list.pinned === selected ? selected : undefined;
  const read = useRead<unknown>(outside ? matrixPath(outside) : null);
  if (!outside) return { head: inPage ?? items[0], refresh: read.refresh };
  let found: MatrixHead | undefined;
  let error = read.error;
  try {
    // 读取已结束却没有正文（如 204）同样算无效响应：只在这里判，不改客户端对 204 的全局语义
    if (!read.loading && !read.error && read.data == null) throw new Error('matrix detail empty');
    found = read.data == null ? undefined : parseHead(read.data);
    if (found && found.id !== outside) throw new Error('matrix detail id mismatch');
  } catch (cause) {
    found = undefined;
    error = cause;
  }
  return { head: found, error, refresh: read.refresh };
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
  const shown = useShown(list, selected);
  const head = shown.head;
  // 写成功后按回执状态切到所在页签，并定位回执对象（不在当前页也展示）；结果未明或被拒时只刷新（回查）。
  const saved: Saved = (receipt) => {
    shown.refresh();
    if (!receipt) return list.refresh();
    setSelected(receipt.id);
    const view: View = receipt.status === 'disabled' ? 'disabled' : 'active';
    if (view !== list.view) list.show(view);
    else list.refresh();
    list.pin(receipt.id);
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
        {!!shown.error && <PageState kind="error" error={shown.error} retry={shown.refresh} />}
        {head && <HeadPanel head={head} editable={editable} edit={() => setForm({ head })} saved={saved} />}
        {!head && !shown.error && !list.loading && <Empty description={m.pick} />}
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
      <Input.Search allowClear placeholder={m.search} maxLength={100} onSearch={(value) => list.search(value.trim())} />
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
        <Button disabled={!list.offset} onClick={() => list.turn(Math.max(0, list.offset - PAGE_SIZE))}>
          {m.prev}
        </Button>
        <Button disabled={!list.page?.hasMore} onClick={() => list.turn(list.offset + PAGE_SIZE)}>
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
      <StatusActions key={`${head.id}@${head.revision}`} {...props} />
      <StructureEditor key={head.id} head={head} editable={props.editable} saved={props.saved} />
    </>
  );
}

import { Alert, App, Button, Checkbox, Dropdown, Segmented, Space, Table, Tag } from 'antd';
import { text } from './messages.js';
import { useEffect, useState } from 'react';
import { rejectionMessage, type ApiClient } from '../foundation/client.js';
import { useApiClient } from '../foundation/Session.js';
import { RemoteContent, useRemote } from '../org/page-support.js';
import {
  detailPath,
  display,
  downloadName,
  exportPath,
  missing,
  previewRows,
  type ExportFile,
  type PreviewNode,
} from './model.js';

type Format = 'png' | 'svg';
const marks = { added: text.added, changed: text.changed, deactivated: text.stopped };
const columns = [
  {
    title: text.name,
    render: (_: unknown, node: PreviewNode) => (
      <Space>
        {display(node.name)}
        {node.mark && <Tag>{marks[node.mark]}</Tag>}
      </Space>
    ),
  },
  { title: text.head, dataIndex: 'personInChargeName', render: display },
  { title: text.lead, render: () => missing },
  { title: text.capacity, dataIndex: 'establishment', render: display },
];
const svgBlob = (svg: string) => new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });

async function pngOf(svg: Blob) {
  const url = URL.createObjectURL(svg);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const painter = canvas.getContext('2d');
    if (!painter) throw new Error(text.pngError);
    painter.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(text.pngError))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function download(api: ApiClient, url: string, format: Format) {
  const file = await api.request<ExportFile>(url);
  const svg = svgBlob(file.svg);
  const blob = format === 'png' ? await pngOf(svg) : svg;
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = downloadName(file.fileName, format);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function ChartImage({ svg }: { svg: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    // SVG 仅作为图像解码，避免把服务端字符串插入页面 DOM。
    const href = URL.createObjectURL(svgBlob(svg));
    setUrl(href);
    return () => URL.revokeObjectURL(href);
  }, [svg]);
  return url && <img alt={text.chartAlt} src={url} />;
}
function Chart({ url }: { url: string }) {
  const data = useRemote<ExportFile>(url);
  return (
    <RemoteContent state={data}>
      {data.data && (
        <div className="oa-chart">
          <ChartImage svg={data.data.svg} />
        </div>
      )}
    </RemoteContent>
  );
}
function TreePreview({ id, after }: { id: string; after: boolean }) {
  const data = useRemote<{ roots: PreviewNode[] }>(`${detailPath(id)}/preview`);
  return (
    <RemoteContent state={data}>
      {data.data && (
        <Table
          size="small"
          pagination={false}
          rowKey="key"
          columns={columns}
          dataSource={previewRows(data.data.roots, after)}
          expandable={{ defaultExpandAllRows: true }}
        />
      )}
    </RemoteContent>
  );
}
export function Preview({ id }: { id: string }) {
  const api = useApiClient();
  const { message } = App.useApp();
  const [view, setView] = useState('tree');
  const [after, setAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const url = exportPath(id, after);
  const save = async (format: Format) => {
    setBusy(true);
    try {
      await download(api, url, format);
    } catch (error) {
      void message.error(rejectionMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Space wrap className="oa-preview-controls">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'tree', label: text.tree },
            { value: 'chart', label: text.chart },
          ]}
        />
        <Checkbox checked={after} onChange={(event) => setAfter(event.target.checked)}>
          {text.showAfter}
        </Checkbox>
        {view === 'chart' && (
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'png', label: text.png },
                { key: 'svg', label: text.svg },
              ],
              onClick: ({ key }) => void save(key as Format),
            }}
          >
            <Button loading={busy}>{text.export}</Button>
          </Dropdown>
        )}
      </Space>
      {view === 'tree' ? <TreePreview id={id} after={after} /> : <Chart url={url} />}
      <Space wrap className="oa-preview-controls">
        <Checkbox disabled>{text.sync}</Checkbox>
        <Button disabled>{text.stopMode}</Button>
      </Space>
      <Alert type="info" message={text.syncUnavailable} />
    </>
  );
}

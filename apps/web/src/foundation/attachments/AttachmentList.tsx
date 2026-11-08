import { Button, Image, Typography } from 'antd';
import { useState, type ReactNode } from 'react';
import { useSession } from '../Session.js';
import type { AttachmentView } from './api.js';
import { openAttachment, useAttachmentBlob, useAttachmentDownload } from './blob.js';
import { attachmentText as text } from './messages.js';
import './attachments.css';

export interface AttachmentListProps {
  readonly items: readonly AttachmentView[];
  /** 内容地址：临时文件走 `/attachments/:id/content`，已绑定文件走所在载体的下载路由（blob.ts 路径构造函数）。 */
  readonly pathOf: (item: AttachmentView) => string | undefined;
  /** 新标签打开时允许的内容类型（用途 types，不含 SVG）。 */
  readonly types: readonly string[];
  readonly onRemove?: (item: AttachmentView) => void;
  readonly removing?: (item: AttachmentView) => boolean;
  readonly note?: (item: AttachmentView) => ReactNode;
}

/** 只读展示：缩略图（点击放大）、文件名（新标签打开）、大小、下载；传入 onRemove 时每项带“删除”。 */
export function AttachmentList(props: AttachmentListProps) {
  const { tenantId } = useSession();
  if (!props.items.length) return null;
  return (
    <Image.PreviewGroup>
      <ul className="attachment-list">
        {props.items.map((item) => (
          <AttachmentRow key={`${tenantId}:${item.id}`} {...props} item={item} tenantId={tenantId} />
        ))}
      </ul>
    </Image.PreviewGroup>
  );
}

type RowProps = AttachmentListProps & { readonly item: AttachmentView; readonly tenantId: string };

function AttachmentRow({ item, tenantId, pathOf, types, onRemove, removing, note }: RowProps) {
  const path = item.missing ? undefined : pathOf(item);
  const download = useAttachmentDownload(tenantId);
  const [openError, setOpenError] = useState<string>();
  const open = async () => {
    if (!path) return;
    setOpenError(undefined);
    const result = await openAttachment(tenantId, path, types);
    if (result !== 'opened') setOpenError(result === 'format' ? text.badFormat : text.loadFailed);
  };
  return (
    <li className="attachment-item" data-attachment={item.id}>
      {path ? (
        <Thumb key={`${tenantId}:${path}`} tenantId={tenantId} path={path} alt={item.filename} />
      ) : (
        <Blank label={item.missing ? text.missing : ''} />
      )}
      <div className="attachment-meta">
        {path ? (
          <Typography.Link className="attachment-name" onClick={() => void open()}>
            {item.filename}
          </Typography.Link>
        ) : (
          <Typography.Text className="attachment-name" type="secondary">
            {item.filename}
          </Typography.Text>
        )}
        <Typography.Text type="secondary">{formatSize(item.byteSize)}</Typography.Text>
        <Typography.Text type="danger">{download.error ?? openError ?? note?.(item)}</Typography.Text>
      </div>
      {path && (
        <Button size="small" disabled={download.pending} onClick={() => void download.download(path, item.filename)}>
          {text.download}
        </Button>
      )}
      {onRemove && (
        <Button size="small" className="remove" disabled={removing?.(item)} onClick={() => onRemove(item)}>
          {text.remove}
        </Button>
      )}
    </li>
  );
}

/** 以 `租户:路径` 为键挂载（§5.4）：切换即卸载旧会话，旧租户的图片不会在新租户短暂显示。 */
function Thumb({ tenantId, path, alt }: { tenantId: string; path: string; alt: string }) {
  const state = useAttachmentBlob(tenantId, path);
  if (state.status !== 'ready') return <Blank label={state.status === 'failed' ? text.loadFailed : text.loading} />;
  return <Image className="attachment-thumb" src={state.url} alt={alt} width={64} height={64} />;
}

function Blank({ label }: { label: string }) {
  return <span className="attachment-thumb attachment-blank">{label}</span>;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

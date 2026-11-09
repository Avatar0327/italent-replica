import type { AttachmentPurpose } from '@italent/domain';
import { ConfigProvider } from 'antd';
import { useState } from 'react';
import { purposeConfig, type AttachmentView } from './api.js';
import { AttachmentList } from './AttachmentList.js';
import { carrierContentPath, type AttachmentCarrier } from './blob.js';
import { ImageAttachments } from './ImageAttachments.js';

/**
 * 载体投影里的 `attachments`（S2 carrier-read.ts attachmentSummaries）→ 控件的展示项；形状不对的项丢弃。
 * 无字段权时后端整键缺席，这里得到空数组，调用方据“键是否存在”决定是否渲染字段（设计 §5.3）。
 */
export function attachmentViews(value: unknown): AttachmentView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string') return [];
    return [
      {
        id: row.id,
        filename: typeof row.filename === 'string' ? row.filename : '',
        contentType: typeof row.contentType === 'string' ? row.contentType : null,
        byteSize: typeof row.byteSize === 'number' ? row.byteSize : 0,
        uploadedAt: typeof row.uploadedAt === 'string' ? row.uploadedAt : null,
        ...(row.missing === true ? { missing: true as const } : {}),
      },
    ];
  });
}

export interface CarrierAttachmentsProps {
  readonly purpose: AttachmentPurpose;
  readonly carrier: AttachmentCarrier;
  readonly ownerId: string;
  readonly items: readonly AttachmentView[];
}

/** 详情只读展示：内容一律走所在载体的下载路由（带租户头读成 blob:，设计 §5.4），三个载体共用。 */
export function CarrierAttachments({ purpose, carrier, ownerId, items }: CarrierAttachmentsProps) {
  return (
    <AttachmentList
      items={items}
      pathOf={(item) => carrierContentPath(carrier, ownerId, item.id)}
      types={purposeConfig(purpose).types}
    />
  );
}

export interface AttachmentRefsInputProps {
  readonly purpose: AttachmentPurpose;
  readonly carrier: AttachmentCarrier;
  /** 业务单 ID；新建尚无单号时不传，此时只有本次上传的临时文件。 */
  readonly ownerId?: string;
  /** 服务端读回的展开项（与 value 里的 ID 一一对应）。 */
  readonly views: readonly AttachmentView[];
  /** 表单值：附件 ID 数组（后端字段 attachmentRefs）。 */
  readonly value?: readonly string[] | null;
  readonly onChange?: (ids: string[]) => void;
  readonly disabled?: boolean;
  readonly readonly?: boolean;
  readonly onBusyChange?: (busy: boolean) => void;
}

/**
 * 表单字段适配：Form 里存 ID 数组（保存体原样带出、按顺序比较是否修改），控件里是展示项。
 * 展示项按 ID 查：先查服务端最新读回的（409 重读后随之更新），再查本次上传的临时文件；都查不到显示“文件不可用”占位。
 */
export function AttachmentRefsInput({
  purpose,
  carrier,
  ownerId,
  views,
  value,
  onChange,
  ...rest
}: AttachmentRefsInputProps) {
  const [uploaded, setUploaded] = useState<ReadonlyMap<string, AttachmentView>>(() => new Map());
  const items = (value ?? []).map((id) => views.find((view) => view.id === id) ?? uploaded.get(id) ?? placeholder(id));
  return (
    // 只读 / 提交锁由 disabled、readonly 显式传入；这里挡住外层 Form disabled，让查看与下载在审批中照常可用
    <ConfigProvider componentDisabled={false}>
      <ImageAttachments
        purpose={purpose}
        value={items}
        disabled={rest.disabled}
        readonly={rest.readonly}
        onBusyChange={rest.onBusyChange}
        contentPath={ownerId ? (item) => carrierContentPath(carrier, ownerId, item.id) : undefined}
        onChange={(next) => {
          const added = next.filter((view) => view.temporary).map((view) => [view.id, view] as const);
          if (added.length) setUploaded((map) => new Map([...map, ...added]));
          onChange?.(next.map((view) => view.id));
        }}
      />
    </ConfigProvider>
  );
}

const placeholder = (id: string): AttachmentView => ({
  id,
  filename: '',
  contentType: null,
  byteSize: 0,
  uploadedAt: null,
  missing: true,
});

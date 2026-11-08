/**
 * 附件内容的带租户头读取（设计 §5.4，照 shared/PersonAvatar.tsx）。缩略图、预览、新标签打开、下载都从这里出：
 * 服务端缺 X-Tenant-Id 一律 400，故页面不得用 `<img src>` / `<a href>` 直连内容接口，一律带头 fetch 成 Blob 地址。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { attachmentText as text } from './messages.js';

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CARRIERS = {
  selfExit: 'self-service/exit-requests',
  approval: 'approval/instances',
  hrExit: 'employment/exits',
} as const;
export type AttachmentCarrier = keyof typeof CARRIERS;
// 只放行临时内容接口与 S2 的三个载体下载路由，避免把租户头发往别处
const CONTENT_PATHS = [
  new RegExp(`^/api/tenant/attachments/${ID}/content$`),
  new RegExp(`^/api/tenant/(?:${Object.values(CARRIERS).join('|')})/${ID}/attachments/${ID}/content$`),
];

export const isAttachmentContentPath = (path: string) => CONTENT_PATHS.some((pattern) => pattern.test(path));
export const temporaryContentPath = (fileId: string) => `/api/tenant/attachments/${fileId.toLowerCase()}/content`;
export const carrierContentPath = (carrier: AttachmentCarrier, ownerId: string, fileId: string) =>
  `/api/tenant/${CARRIERS[carrier]}/${ownerId.toLowerCase()}/attachments/${fileId.toLowerCase()}/content`;

async function fetchContent(tenantId: string, path: string, signal?: AbortSignal): Promise<Response> {
  if (!tenantId || !isAttachmentContentPath(path)) throw new Error('Invalid attachment content path');
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'x-tenant-id': tenantId }, signal });
  if (!response.ok) throw new Error(`Attachment content ${response.status}`);
  return response;
}

export type AttachmentBlobState = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'failed' };

/**
 * 缩略图 / 预览的 Blob 地址。状态按 `租户:路径` 记账：切换时立即回到加载中（不显示旧图），
 * effect 清理先 abort 再 revoke；失败置 failed，不保留上一张图。调用方仍应按 §5.4 以同一键包一层组件。
 */
export function useAttachmentBlob(tenantId: string, path: string): AttachmentBlobState {
  const key = `${tenantId}:${path}`;
  const [state, setState] = useState<{ key: string; url?: string; failed?: true }>({ key: '' });
  useEffect(() => {
    const controller = new AbortController();
    let url = '';
    fetchContent(tenantId, path, controller.signal)
      .then((response) => response.blob())
      .then(
        (blob) => {
          if (controller.signal.aborted) return;
          url = URL.createObjectURL(blob);
          setState({ key, url });
        },
        () => {
          if (!controller.signal.aborted) setState({ key, failed: true });
        },
      );
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [tenantId, path, key]);
  if (state.key !== key) return { status: 'loading' };
  return state.url ? { status: 'ready', url: state.url } : { status: 'failed' };
}

interface DownloadOptions {
  readonly signal?: AbortSignal;
  /** 尚未释放的地址；卸载时由 useAttachmentDownload 统一释放。 */
  readonly pending?: Set<string>;
}

/** 下载：带头读取 → 不挂载的 `<a download>` 点击 → 下一拍释放地址（给浏览器取走 Blob 留一拍）。失败抛出。 */
export async function downloadAttachment(
  tenantId: string,
  path: string,
  filename: string,
  options: DownloadOptions = {},
): Promise<void> {
  const blob = await (await fetchContent(tenantId, path, options.signal)).blob();
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const url = URL.createObjectURL(blob);
  options.pending?.add(url);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => {
    if (!options.pending || options.pending.delete(url)) URL.revokeObjectURL(url);
  }, 0);
}

/** 下载按钮：请求期间 pending（按钮禁用）；卸载时 abort 在途请求并释放未释放的地址。 */
export function useAttachmentDownload(tenantId: string) {
  const [state, setState] = useState<{ pending: boolean; error?: string }>({ pending: false });
  const live = useRef({ controller: new AbortController(), pending: new Set<string>(), mounted: true });
  useEffect(() => {
    const current = live.current;
    current.mounted = true;
    return () => {
      current.mounted = false;
      current.controller.abort();
      current.controller = new AbortController();
      for (const url of current.pending) URL.revokeObjectURL(url);
      current.pending.clear();
    };
  }, []);
  const download = useCallback(
    async (path: string, filename: string) => {
      const current = live.current;
      setState({ pending: true });
      try {
        await downloadAttachment(tenantId, path, filename, {
          signal: current.controller.signal,
          pending: current.pending,
        });
        if (current.mounted) setState({ pending: false });
      } catch {
        if (current.mounted) setState({ pending: false, error: text.downloadFailed });
      }
    },
    [tenantId],
  );
  return { ...state, download };
}

/** 点文件名在新标签打开（Q-8 原站内联打开）：先同步开标签防拦截；只认用途允许的位图类型，60 秒后释放地址。 */
export async function openAttachment(
  tenantId: string,
  path: string,
  types: readonly string[],
): Promise<'opened' | 'format' | 'failed'> {
  const tab = window.open('', '_blank');
  if (!tab) return 'failed';
  tab.opener = null;
  try {
    const response = await fetchContent(tenantId, path);
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!types.includes(type)) {
      tab.close();
      return 'format';
    }
    const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type }));
    tab.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return 'opened';
  } catch {
    tab.close();
    return 'failed';
  }
}

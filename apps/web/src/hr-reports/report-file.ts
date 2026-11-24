import { useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../foundation/client.js';
import { m } from './messages.js';
import { reportFailure, type ReportFailure } from './model.js';

export async function readReportFile(path: string, tenantId: string, signal: AbortSignal, mediaType: string) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'x-tenant-id': tenantId }, signal });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { error?: { code?: string; details?: unknown } } | undefined;
    const retry = response.headers.get('retry-after');
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'REQUEST_FAILED',
      'unknown',
      m.exportFailed,
      payload?.error,
      retry && /^\d+$/.test(retry) ? Number(retry) : undefined,
    );
  }
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== mediaType)
    throw new Error(m.exportFailed);
  return response;
}

/** 页面卸载时取消文件读取并释放 URL，迟到回执也不得触发保存。 */
export function useReportFileDownload(disabled: boolean, onFailure: (failure?: ReportFailure) => void) {
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>());
  useLayoutEffect(() => {
    const downloads = urls.current;
    return () => {
      controller.current?.abort();
      for (const url of downloads) URL.revokeObjectURL(url);
      downloads.clear();
    };
  }, []);
  async function save(load: (signal: AbortSignal) => Promise<{ blob: Blob; name: string }>) {
    if (disabled || controller.current) return;
    setBusy(true);
    onFailure();
    const active = new AbortController();
    controller.current = active;
    try {
      const { blob, name } = await load(active.signal);
      if (active.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      // 保留到浏览器接管文件，离开页面时由卸载处理释放。
      setTimeout(() => {
        if (urls.current.delete(url)) URL.revokeObjectURL(url);
      }, 1000);
    } catch (error) {
      if (!active.signal.aborted) onFailure(reportFailure(error));
    } finally {
      if (!active.signal.aborted) {
        controller.current = null;
        setBusy(false);
      }
    }
  }
  return { busy, save };
}

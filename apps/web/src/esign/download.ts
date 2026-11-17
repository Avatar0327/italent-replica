// F-481 §8.2、§8.3：签署文件下载（GET 只读，无写命令）。只保存服务端返回的 PDF / zip，错误响应不落盘成假成功；
// 同一时刻只跑一单，离开页面时中止请求，迟到的结果不再提示、不再保存（同 job/graph-download.ts）。
import { App } from 'antd';
import { useEffect, useRef } from 'react';
import { useSession } from '../foundation/Session.js';
import { m } from './messages.js';

const TYPES = ['application/pdf', 'application/zip'];
class DownloadFailure extends Error {}

function fileNameOf(response: Response) {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') ?? '')?.[1];
  try {
    return encoded ? decodeURIComponent(encoded) : 'esign.pdf';
  } catch {
    return 'esign.pdf';
  }
}
/** 409（含未完成的签署 ESIGN_NOT_COMPLETED）、503（生成名额满）显示服务端原因；其余用固定文案。 */
async function failureOf(response: Response) {
  const body = (await response.json().catch(() => undefined)) as { error?: { message?: unknown } } | undefined;
  const reason = typeof body?.error?.message === 'string' ? body.error.message : undefined;
  if (response.status === 409) return reason ?? m.download.notCompleted;
  if (response.status === 503) return reason ?? m.download.busy;
  return response.status === 403 ? m.download.forbidden : m.download.failed;
}

export function useESignDownload() {
  const session = useSession();
  const { message } = App.useApp();
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  return async (path: string) => {
    if (running.current) return;
    running.current = true;
    const active = new AbortController();
    controller.current = active;
    try {
      const response = await fetch(path, {
        credentials: 'same-origin',
        headers: { 'x-tenant-id': session.tenantId },
        signal: active.signal,
      });
      if (!response.ok) throw new DownloadFailure(await failureOf(response));
      const type = response.headers.get('content-type') ?? '';
      if (!TYPES.some((item) => type.includes(item))) throw new DownloadFailure(m.download.failed);
      const blob = await response.blob();
      if (active.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileNameOf(response);
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (failure) {
      if (!active.signal.aborted)
        void message.error(failure instanceof DownloadFailure ? failure.message : m.download.failed);
    } finally {
      if (!active.signal.aborted) running.current = false;
    }
  };
}

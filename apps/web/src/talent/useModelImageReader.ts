import { useCallback, useEffect, useRef, useState } from 'react';
import { modelImageContent, modelImageRequest, type ModelImageView } from './model-image-api.js';
import { modelImageText as text } from './model-image-messages.js';

/** 图片只使用当前授权读取出的 Blob URL；刷新先清图，失败、卸载与过期请求都不能留下旧图。 */
export function useModelImageReader(tenantId: string, path: string) {
  const [view, setView] = useState<ModelImageView | null>(null);
  const [preview, setPreview] = useState('');
  const [reading, setReading] = useState(true);
  const [error, setError] = useState('');
  const live = useRef(true);
  const sequence = useRef(0);
  const url = useRef('');
  const abort = useRef<AbortController | null>(null);
  const clearPreview = useCallback(() => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = '';
    setPreview('');
  }, []);
  const load = useCallback(async () => {
    const token = ++sequence.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    clearPreview();
    setView(null);
    setReading(true);
    setError('');
    try {
      const next = await modelImageRequest<ModelImageView>(tenantId, path, { signal: controller.signal });
      if (!live.current || token !== sequence.current) return null;
      const blob = next.modelImage
        ? await modelImageContent(tenantId, `${path}/attachments/${next.modelImage.id}/content`, controller.signal)
        : null;
      if (!live.current || token !== sequence.current) return null;
      if (blob) {
        url.current = URL.createObjectURL(blob);
        setPreview(url.current);
      }
      setView(next);
      return next;
    } catch (cause) {
      if (live.current && token === sequence.current) setError(cause instanceof Error ? cause.message : text.failed);
      return null;
    } finally {
      if (live.current && token === sequence.current) setReading(false);
    }
  }, [tenantId, path, clearPreview]);
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
      sequence.current += 1;
      abort.current?.abort();
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = '';
    };
  }, [load]);
  const updateRevision = (revision: number) => setView((value) => (value ? { ...value, revision } : value));
  return { view, preview, reading, error, load, updateRevision };
}

export type ModelImageReader = ReturnType<typeof useModelImageReader>;

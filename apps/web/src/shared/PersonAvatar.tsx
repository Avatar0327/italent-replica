import { useEffect, useState } from 'react';
import type { AvatarReference } from '../account/avatar-api.js';
import { accountText as text } from '../account/messages.js';
import './person-avatar.css';

interface Props {
  readonly tenantId: string;
  readonly name: string;
  readonly avatar?: AvatarReference | null;
  readonly size?: number;
}
const COLORS = ['#286aaa', '#287e67', '#9b514d', '#806193', '#996e2c', '#496f83'] as const;

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  if (/^[a-z]/i.test(parts[0] ?? ''))
    return `${parts[0]?.[0] ?? ''}${parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : ''}`.toUpperCase();
  return Array.from(name.trim()).slice(-2).join('');
}

function contentPath(avatar: AvatarReference | null | undefined) {
  if (!avatar) return null;
  const pattern = /^\/api\/tenant\/avatars\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/content$/i;
  const match = pattern.exec(avatar.url);
  if (!match || match[1]!.toLowerCase() !== avatar.id.trim().toLowerCase()) return null;
  return `/api/tenant/avatars/${match[1]!.toLowerCase()}/content`;
}

/** 头像引用只在当前租户内认证读取；租户或引用切换会立即卸载旧图片会话。 */
export function PersonAvatar(props: Props) {
  return <AvatarSession key={`${props.tenantId}:${contentPath(props.avatar) ?? ''}`} {...props} />;
}

function AvatarSession({ tenantId, name, avatar, size = 40 }: Props) {
  const [preview, setPreview] = useState('');
  const contentUrl = contentPath(avatar);
  useEffect(() => {
    const controller = new AbortController();
    let url = '';
    // 服务端返回的引用也只能指向头像内容接口，避免将租户头发往外部地址。
    if (contentUrl) {
      void fetch(contentUrl, {
        credentials: 'same-origin',
        headers: { 'x-tenant-id': tenantId },
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) return;
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          url = URL.createObjectURL(blob);
          setPreview(url);
        })
        .catch(() => {
          // 撤权、已删除或网络失败都回退姓名缩写，不保留旧头像。
        });
    }
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [tenantId, contentUrl]);
  const style = { width: size, height: size, borderRadius: '50%', flexShrink: 0 } as const;
  return preview ? (
    <img
      src={preview}
      alt={`${name}${text.alt}`}
      style={{ ...style, objectFit: 'cover' }}
      onError={() => setPreview('')}
    />
  ) : (
    <span
      role="img"
      aria-label={`${name}${text.alt}`}
      style={{
        ...style,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        backgroundColor: COLORS[Array.from(name).reduce((sum, char) => sum + char.codePointAt(0)!, 0) % COLORS.length],
        fontSize: size * 0.35,
        fontWeight: 600,
        verticalAlign: 'middle',
      }}
    >
      {initials(name)}
    </span>
  );
}

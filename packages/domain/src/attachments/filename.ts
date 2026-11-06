/**
 * F-479 文件名规整（设计 §1.4）：只保留最后一个路径分隔符之后的部分，去掉控制字符与双向控制字符（防止伪装扩展名），
 * 去首尾空白；空或超过 255 个字符返回 null（由调用方报 400）。
 */
// 有意匹配控制字符与双向控制字符（设计 §1.4）
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

export const ATTACHMENT_FILENAME_MAX = 255;

export function sanitizeAttachmentFilename(raw: string): string | null {
  const tail = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);
  const name = tail.replace(CONTROL, '').trim();
  return name.length === 0 || name.length > ATTACHMENT_FILENAME_MAX ? null : name;
}

/** 扩展名（小写，无点）；没有点返回空串。 */
export function attachmentExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * Content-Disposition（RFC 6266 / 5987）：ASCII 回退名把非 ASCII、引号、反斜杠与控制字符换成下划线，
 * filename* 带 UTF-8 百分号编码，兼容新旧浏览器。
 */
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * 附件控件文案（DEC-045 资源文件）。前三条为原站原文（设计 §5.1 文案表，Q-3 已取证）；
 * 错误码到文案的映射集中在本模块，页面不出现英文原因码、也不显示服务端 message（自查 7）。
 */
export const attachmentText = {
  tooMany: '总文件数不能超过5个',
  tooLarge: '文件大小不能超过10MB',
  badFormat: '文件格式错误',
  tempLimit: '未保存的附件过多，请先保存草稿或删除不需要的图片',
  unknown: '上传结果未知，请重试（重试前会先确认是否已上传成功）',
  expired: '附件已失效，请重新选择',
  downloadFailed: '下载失败，请重试',
  uploading: '附件上传中',
  denied: '暂无上传附件的权限',
  changed: '附件状态已变化，请重新选择',
  invalid: '文件内容校验未通过，请重新选择',
  failed: '上传失败，请重试',
  rateLimit: '请求过于频繁，请稍后再试',
  rateLimitSeconds: (seconds: number) => `请求过于频繁，请在 ${seconds} 秒后再试`,
  deleteFailed: '删除失败，请重试',
  deleteUnknown: '删除结果未知，请重试',
  loadFailed: '加载失败',
  loading: '加载中',
  missing: '文件已不可用',
  upload: '上传',
  retry: '重试',
  remove: '删除',
  download: '下载',
  queued: '等待上传',
} as const;

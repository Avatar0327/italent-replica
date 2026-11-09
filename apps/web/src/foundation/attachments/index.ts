/** F-479 通用附件能力前端（设计 §5.1、§5.4）。S4 只提供控件与读取出口，S5 接入本人离职表单与详情。 */
export { ImageAttachments, type ImageAttachmentsProps } from './ImageAttachments.js';
export { AttachmentList, formatSize, type AttachmentListProps } from './AttachmentList.js';
export type { AttachmentReceipt, AttachmentView } from './api.js';
export {
  carrierContentPath,
  downloadAttachment,
  isAttachmentContentPath,
  openAttachment,
  temporaryContentPath,
  useAttachmentBlob,
  useAttachmentDownload,
  type AttachmentBlobState,
  type AttachmentCarrier,
} from './blob.js';
export { attachmentText } from './messages.js';
export {
  AttachmentRefsInput,
  CarrierAttachments,
  attachmentViews,
  type AttachmentRefsInputProps,
  type CarrierAttachmentsProps,
} from './CarrierAttachments.js';

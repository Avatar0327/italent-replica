import { useConfirmDialog, type ConfirmText } from './useConfirmDialog.js';
import { hrFormText as h } from './messages.js';

const terminateText: ConfirmText = {
  title: h.terminateTitle,
  content: h.terminateContent,
  okText: h.confirm,
  cancelText: h.cancel,
};

/** F-504“继续保存将终止原合同”确认框：取消即不发请求，卸载按取消收尾（实现见 useConfirmDialog）。 */
export function useTerminateConfirm() {
  return useConfirmDialog(terminateText);
}

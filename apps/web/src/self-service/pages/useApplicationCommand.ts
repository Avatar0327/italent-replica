import { useRef, useState } from 'react';
import { TransferApiError, requestError } from '../../transfer/api.js';
import type { ApplicationCommand, ApplicationCommandRunner } from '../shared/application-command.js';
import type { TransferBusiness } from '../../transfer/types.js';
import { messages as m } from './messages.js';

/** DEC-464：页面持有只读处理标记；关闭抽屉不撤销请求、不重放命令。 */
export function useApplicationCommand(onSaved?: (result: TransferBusiness) => void) {
  const active = useRef<ApplicationCommand | null>(null);
  const [pending, setPending] = useState<ApplicationCommand | null>(null);
  const [saved, setSaved] = useState<TransferBusiness | null>(null);
  const [error, setError] = useState('');
  const run: ApplicationCommandRunner = async (command, execute) => {
    if (active.current) throw new Error(m.processing);
    active.current = command;
    setPending(command);
    setError('');
    try {
      const result = await execute();
      if (!result.id || !Number.isInteger(result.revision) || !result.status) throw new Error(m.processing);
      setSaved(result);
      active.current = null;
      setPending(null);
      onSaved?.(result);
      return result;
    } catch (cause) {
      // 只有确定的拒绝能解除锁定；超时、断线、服务端异常都不能证明原命令未成功。
      if (cause instanceof TransferApiError && cause.status < 500) {
        active.current = null;
        setPending(null);
        setError(requestError(cause));
      }
      throw cause;
    }
  };
  return { pending, saved, error, run };
}

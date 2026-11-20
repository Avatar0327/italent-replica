import { useSyncExternalStore } from 'react';
import type { TransferBusiness } from '../../transfer/types.js';
import type { ApplicationCommandRunner } from '../shared/application-command.js';
import {
  clearConfirmedApplication,
  queryApplicationResult,
  readApplicationSession,
  runApplicationCommand,
  subscribeApplicationSession,
} from './application-session.js';

/** 路由重挂载、关闭重开、整页刷新都恢复只读标记（F-110）；在途命令只能按原命令 ID 查询结果，不重发。 */
export function useApplicationCommand(scope: string, onSaved?: (result: TransferBusiness) => void) {
  const state = useSyncExternalStore(subscribeApplicationSession, () => readApplicationSession(scope));
  const run: ApplicationCommandRunner = async (command, execute) => {
    const result = await runApplicationCommand(scope, command, execute);
    onSaved?.(result);
    return result;
  };
  return {
    ...state,
    run,
    query: (tenantId: string) => queryApplicationResult(scope, tenantId),
    clearConfirmed: () => clearConfirmedApplication(scope),
  };
}
export type ApplicationState = ReturnType<typeof useApplicationCommand>;

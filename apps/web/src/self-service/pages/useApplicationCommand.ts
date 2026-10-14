import { useSyncExternalStore } from 'react';
import type { TransferBusiness } from '../../transfer/types.js';
import type { ApplicationCommandRunner } from '../shared/application-command.js';
import {
  clearConfirmedApplication,
  readApplicationSession,
  runApplicationCommand,
  subscribeApplicationSession,
} from './application-session.js';

/** 同一页面内的路由重挂载只恢复只读标记或已知单号，不恢复在途命令。 */
export function useApplicationCommand(scope: string, onSaved?: (result: TransferBusiness) => void) {
  const state = useSyncExternalStore(subscribeApplicationSession, () => readApplicationSession(scope));
  const run: ApplicationCommandRunner = async (command, execute) => {
    const result = await runApplicationCommand(scope, command, execute);
    onSaved?.(result);
    return result;
  };
  return { ...state, run, clearConfirmed: () => clearConfirmedApplication(scope) };
}

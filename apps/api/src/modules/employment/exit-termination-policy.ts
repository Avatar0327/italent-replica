/**
 * 离职生效时终止在途流程的配置读取（DEC-725；口径见 packages/domain/src/employment/exit-termination.ts）。
 * 离职生效、离职预览、离职发起 / 提交门禁（转正在途拦截）与各订阅方都从这里取同一份勾选，不各读一套。
 * 退休（F-351）暂不接这份配置：kind = retirement 时返回 null，调用方走原有口径；配置本身按流程类型存，退休接入时直接复用。
 */
import {
  EXIT_TERMINATION_FLOWS,
  EXIT_TERMINATION_SETTING_KEY,
  exitTerminationPolicy,
  terminatedByExit,
  validExitTerminationSetting,
  type ExitTerminationFlow,
  type ExitTerminationSetting,
} from '@italent/domain';
import type { Tx } from '@italent/db';
import { readEffectiveSetting, registerSettingValidator } from '../tenant-settings/service.js';

registerSettingValidator(EXIT_TERMINATION_SETTING_KEY, validExitTerminationSetting);

export async function readExitTermination(tx: Tx, tenantId: string): Promise<ExitTerminationSetting> {
  return exitTerminationPolicy((await readEffectiveSetting(tx, tenantId, EXIT_TERMINATION_SETTING_KEY)).value);
}

/** 本次离职适用的勾选；退休返回 null（沿用原口径，F-351 再接）。 */
export async function exitTerminationOf(
  tx: Tx,
  tenantId: string,
  exitKind: string,
): Promise<ExitTerminationSetting | null> {
  return exitKind === 'retirement' ? null : readExitTermination(tx, tenantId);
}

/** 某组中“未勾选”的流程码（SQL 过滤与门禁用）。 */
export function untickedFlows(policy: ExitTerminationSetting, group: string): ExitTerminationFlow[] {
  return (Object.keys(policy) as ExitTerminationFlow[]).filter(
    (flow) => !policy[flow] && EXIT_TERMINATION_FLOWS[flow].group === group,
  );
}

/** policy 为 null（退休）= 原口径：全部终止。 */
export function terminates(
  policy: ExitTerminationSetting | null,
  flow: ExitTerminationFlow | null,
  date: string | null,
  lastWorkDate: string,
) {
  return !policy || !flow || terminatedByExit(policy, flow, date, lastWorkDate);
}

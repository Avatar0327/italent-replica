import { and, eq, esignTaskFiles, type Tx } from '@italent/db';
import { ESIGN_SCENE_LABEL, esignFileLabel } from '@italent/domain';
import type { SignTask } from './sign-events.js';

/** F-505 §7：纯文本模板也不能经提醒或终态通知间接读取人员值。 */
export function minimalSignNotice(task: Pick<SignTask, 'id' | 'scene'>) {
  return task.scene === 'transfer' ? null : { scene: task.scene, taskNumber: task.id };
}

export async function reminderPayload(tx: Tx, tenantId: string, task: SignTask, deadlineLabel: () => string) {
  const minimal = minimalSignNotice(task);
  if (minimal) return minimal;
  const files = await tx
    .select({ name: esignTaskFiles.templateName })
    .from(esignTaskFiles)
    .where(and(eq(esignTaskFiles.tenantId, tenantId), eq(esignTaskFiles.taskId, task.id)))
    .orderBy(esignTaskFiles.seq);
  return {
    场景: ESIGN_SCENE_LABEL,
    文件名称: esignFileLabel(files.map((file) => file.name)),
    截止时间: deadlineLabel(),
  };
}

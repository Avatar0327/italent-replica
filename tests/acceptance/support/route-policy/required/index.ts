/**
 * 必需项显式表（F-039 PR-A 第 4 轮，DEC-348②）：按模块分文件，这里合并。键 = `METHOD 最终路径`，与运行时端点
 * 完全相等（AC-PRM-FW-02-required）。表只来自对源码的人工审定，不得从声明或探测结果重新生成；新增路由、改处理函数
 * 或改授权辅助函数时，开发同步复核受影响的表项（证据摘要不一致会报 EVIDENCE_STALE），审查核对表的 diff。
 */
import { APPROVAL } from './approval.js';
import { AUDIT } from './audit.js';
import { AVATAR } from './avatar.js';
import { CONTRACTS } from './contracts.js';
import { EMPLOYMENT } from './employment.js';
import { ESTABLISHMENT } from './establishment.js';
import { IDP } from './idp.js';
import { JOB } from './job.js';
import { ORG } from './org.js';
import { PERMISSION } from './permission.js';
import { PERSONNEL } from './personnel.js';
import { ROOT } from './root.js';
import { SELF_SERVICE } from './self-service.js';
import { SURVEY360 } from './survey360.js';
import { TALENT } from './talent.js';
import { TENANT_SETTINGS } from './tenant-settings.js';
import type { Obligation, RequiredTable } from './types.js';

const PARTS: readonly RequiredTable[] = [
  ROOT,
  TENANT_SETTINGS,
  AUDIT,
  AVATAR,
  SELF_SERVICE,
  ORG,
  JOB,
  ESTABLISHMENT,
  PERSONNEL,
  CONTRACTS,
  PERMISSION,
  EMPLOYMENT,
  APPROVAL,
  TALENT,
  SURVEY360,
  IDP,
];

function mergeParts(parts: readonly RequiredTable[]): RequiredTable {
  const out: Record<string, readonly Obligation[]> = {};
  for (const part of parts) {
    for (const [key, obligations] of Object.entries(part)) {
      if (Object.hasOwn(out, key)) throw new Error(`必需项表重复登记 ${key}`);
      out[key] = obligations;
    }
  }
  return out;
}

export const REQUIRED: RequiredTable = mergeParts(PARTS);

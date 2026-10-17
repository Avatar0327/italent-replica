/**
 * 必需项显式表（F-039 PR-A 第 4 轮，DEC-348②）：按模块分文件，这里合并。键 = `METHOD 最终路径`，与运行时端点
 * 完全相等（AC-PRM-FW-02-required）。表只来自对源码的人工审定，不得从声明或探测结果重新生成；新增路由、改处理函数
 * 或改授权辅助函数时，开发同步复核受影响的表项（证据摘要不一致会报 EVIDENCE_STALE），审查核对表的 diff。
 */
import { APPROVAL } from './approval.js';
import { AUDIT } from './audit.js';
import { AVATAR } from './avatar.js';
import { COMMAND_RESULT } from './command-result.js';
import { CONTRACTS } from './contracts.js';
import { EMPLOYMENT } from './employment.js';
import { ESTABLISHMENT } from './establishment.js';
import { EVALUATION } from './evaluation.js';
import { IDP } from './idp.js';
import { JOB } from './job.js';
import { OFFERS } from './offers.js';
import { ORG } from './org.js';
import { PERMISSION } from './permission.js';
import { PERSONNEL } from './personnel.js';
import { QUALIFICATION } from './qualification.js';
import { ROOT } from './root.js';
import { SELF_SERVICE } from './self-service.js';
import { SURVEY360 } from './survey360.js';
import { TALENT } from './talent.js';
import { SUCCESSION } from './succession.js';
import { TALENT_REVIEW } from './talent-review.js';
import { TENANT_SETTINGS } from './tenant-settings.js';
import type { Obligation, RequiredTable } from './types.js';

/** 按模块拆开的必需项表（键 = `required/<模块>.ts` 的文件名）；F-124 起共享测试按它判断条目归属哪个模块。 */
export const REQUIRED_BY_MODULE: Readonly<Record<string, RequiredTable>> = {
  root: ROOT,
  'tenant-settings': TENANT_SETTINGS,
  audit: AUDIT,
  avatar: AVATAR,
  'command-result': COMMAND_RESULT,
  'self-service': SELF_SERVICE,
  org: ORG,
  job: JOB,
  establishment: ESTABLISHMENT,
  personnel: PERSONNEL,
  contracts: CONTRACTS,
  offers: OFFERS,
  permission: PERMISSION,
  employment: EMPLOYMENT,
  approval: APPROVAL,
  talent: TALENT,
  survey360: SURVEY360,
  idp: IDP,
  'talent-review': TALENT_REVIEW,
  qualification: QUALIFICATION,
  evaluation: EVALUATION,
  succession: SUCCESSION,
};

const PARTS: readonly RequiredTable[] = Object.values(REQUIRED_BY_MODULE);

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

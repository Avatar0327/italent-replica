import type { ModuleDeclared } from '../../module-declared.js';
import { APPROVAL_DECLARED } from './approval.js';
import { AUDIT_DECLARED } from './audit.js';
import { AVATAR_DECLARED } from './avatar.js';
import { COMMAND_RESULT_DECLARED } from './command-result.js';
import { CONTRACTS_DECLARED } from './contracts.js';
import { EMPLOYMENT_DECLARED } from './employment.js';
import { ESTABLISHMENT_DECLARED } from './establishment.js';
import { EVALUATION_DECLARED } from './evaluation.js';
import { IDP_DECLARED } from './idp.js';
import { JOB_DECLARED } from './job.js';
import { ORG_DECLARED } from './org.js';
import { PERMISSION_DECLARED } from './permission.js';
import { PERSONNEL_DECLARED } from './personnel.js';
import { QUALIFICATION_DECLARED } from './qualification.js';
import { ROOT_DECLARED } from './root.js';
import { SELF_SERVICE_DECLARED } from './self-service.js';
import { SUCCESSION_DECLARED } from './succession.js';
import { SURVEY360_DECLARED } from './survey360.js';
import { TALENT_DECLARED } from './talent.js';
import { TALENT_REVIEW_DECLARED } from './talent-review.js';
import { TENANT_SETTINGS_DECLARED } from './tenant-settings.js';

/** 键 = `required/<模块>.ts` 的模块名；全部模块都接入，暂无条目的写空声明。 */
export const DECLARED: Readonly<Record<string, ModuleDeclared>> = {
  approval: APPROVAL_DECLARED,
  audit: AUDIT_DECLARED,
  avatar: AVATAR_DECLARED,
  'command-result': COMMAND_RESULT_DECLARED,
  contracts: CONTRACTS_DECLARED,
  employment: EMPLOYMENT_DECLARED,
  establishment: ESTABLISHMENT_DECLARED,
  evaluation: EVALUATION_DECLARED,
  idp: IDP_DECLARED,
  job: JOB_DECLARED,
  org: ORG_DECLARED,
  permission: PERMISSION_DECLARED,
  personnel: PERSONNEL_DECLARED,
  qualification: QUALIFICATION_DECLARED,
  root: ROOT_DECLARED,
  'self-service': SELF_SERVICE_DECLARED,
  succession: SUCCESSION_DECLARED,
  survey360: SURVEY360_DECLARED,
  talent: TALENT_DECLARED,
  'talent-review': TALENT_REVIEW_DECLARED,
  'tenant-settings': TENANT_SETTINGS_DECLARED,
};

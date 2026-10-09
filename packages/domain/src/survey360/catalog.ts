/**
 * 360 对象目录与内置身份（DEC-280；docs/02_业务建模/25 §8）：360 身份由企业管理员在“用户授权”里授予，
 * 走平台“身份 × 应用”（应用 Survey360）。字段 = 管理端接口 DTO 的键；按钮承载三类内置身份的差别：
 * “全部活动”（系统管理员看全部活动、不受精细化权限限制）、“编辑他人套卷”、“从系统管理中同步人员信息”。
 */
import type {
  ButtonDefinition,
  DataOperation,
  ObjectDefinition,
  ObjectPermission,
} from '../permission/object-permission.js';

export const SURVEY360_APP = 'Survey360';

const button = (code: string, level: ButtonDefinition['level'], requires?: DataOperation): ButtonDefinition =>
  requires ? { code, level, requires } : { code, level };
const crud = [
  button('create', 'list', 'create'),
  button('update', 'detail', 'update'),
  button('delete', 'detail', 'delete'),
];

function object(code: string, fields: readonly string[], system: readonly string[], buttons: ButtonDefinition[]) {
  const systems = new Set(['id', 'revision', ...system]);
  return {
    code: `${SURVEY360_APP}.${code}`,
    application: SURVEY360_APP,
    fields: [...new Set([...systems, ...fields])].map((f) => ({ code: f, system: systems.has(f) })),
    buttons,
  } satisfies ObjectDefinition;
}

export const SURVEY360_BUTTONS = {
  allActivities: 'viewAll',
  editOthers: 'editOthers',
  sync: 'sync',
  finePermission: 'finePermission',
} as const;

export const SURVEY360_OBJECTS = {
  activity: object(
    'Activity',
    ['name', 'scene', 'form', 'welcome', 'showAppraiserName', 'roleDisplay'],
    ['status', 'ownerUserId', 'startedAt', 'endedAt', 'scoredAt'],
    [
      ...crud,
      button('enable', 'detail', 'update'),
      button('disable', 'detail', 'update'),
      button(SURVEY360_BUTTONS.allActivities, 'list'),
    ],
  ),
  relation: object(
    'Relation',
    ['personId', 'person', 'questionnaireIds', 'appraiserPersonId', 'appraiser', 'roleId', 'confirmerPersonId'],
    [
      'activityId',
      'objectId',
      'roleName',
      'source',
      'status',
      // PR-B 进程控制：评价者列表与进度明细
      'name',
      'email',
      'lastSentAt',
      'progress',
      'emailState',
      'todo',
      'relationId',
      'objectName',
    ],
    [
      ...crud,
      button('import', 'list', 'create'),
      button('autoAdd', 'list', 'create'),
      button('invite', 'list', 'update'),
    ],
  ),
  result: object(
    'Result',
    [],
    [
      'questionnaireId',
      'level',
      'itemId',
      'scope',
      'roleId',
      'roleName',
      'score',
      'raterCount',
      // PR-B 个人报告（列表行、报告快照）、结果报表、转发预览
      'objectId',
      'objectName',
      'department',
      'position',
      'template',
      'status',
      'generatedAt',
      'cover',
      'questionnaires',
      'statement',
      'questionnaireName',
      'itemName',
      'values',
      'reportId',
      'recipientName',
      'recipientEmail',
      'relation',
    ],
    [button('generateReport', 'list', 'update'), button('forwardReport', 'list', 'update')],
  ),
  // 答卷：查看（审计按真实对象判定，第 3 轮 R2-P2-4）；PR-B 原始数据卡片、屏蔽与重新作答
  answer: object(
    'Answer',
    [],
    [
      'activityId',
      'relationId',
      'questionnaireId',
      'status',
      'answers',
      'suggestion',
      'objectId',
      'objectName',
      'questionnaireName',
      'role',
      'blocked',
      'blockSource',
      'total',
      'items',
    ],
    [button('block', 'detail', 'update'), button('reanswer', 'detail', 'update')],
  ),
  questionnaire: object(
    'Questionnaire',
    ['name', 'type', 'scoreMethod', 'guide', 'excellence', 'roles', 'scales', 'dimensions', 'questions'],
    ['status', 'createdBy'],
    [...crud, button('enable', 'detail', 'update'), button(SURVEY360_BUTTONS.editOthers, 'detail', 'update')],
  ),
  person: object(
    'Person',
    ['name', 'email', 'mobile', 'staffCode', 'department', 'position', 'superiorPersonId'],
    ['employeeId', 'previousEmployeeId', 'emailLocked', 'source'],
    [button('create', 'list', 'create'), button('update', 'detail', 'update'), button(SURVEY360_BUTTONS.sync, 'list')],
  ),
  settings: object(
    'Settings',
    ['name', 'displayText', 'finePermission', 'showTextRole'],
    ['code', 'builtin', 'sort'],
    [
      button('create', 'list', 'create'),
      button('update', 'detail', 'update'),
      button(SURVEY360_BUTTONS.finePermission, 'list', 'update'),
    ],
  ),
} as const;

export interface Survey360Profile {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly objects: readonly ObjectPermission[];
}

/** 全部字段可见、非系统字段可编辑、全部数据操作，按钮去掉 without 中的。 */
function grant(definition: ObjectDefinition, without: readonly string[] = []): ObjectPermission {
  return {
    objectCode: definition.code,
    dataOperations: {
      create: definition.buttons.some((b) => b.requires === 'create'),
      update: definition.buttons.some((b) => b.requires === 'update'),
      delete: definition.buttons.some((b) => b.requires === 'delete'),
    },
    fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
    buttons: definition.buttons
      .filter((b) => !without.includes(b.code))
      .map((b) => ({ buttonCode: b.code, level: b.level })),
  };
}

const ALL = Object.values(SURVEY360_OBJECTS);
const ADVANCED_WITHOUT = [
  SURVEY360_BUTTONS.allActivities,
  SURVEY360_BUTTONS.editOthers,
  SURVEY360_BUTTONS.finePermission,
];

/** 三类内置 360 身份（`25` §8.1）；分子公司 HR-组织者 / 进度推进者等由租户自建（DEC-280①）。 */
export const SURVEY360_PROFILES: readonly Survey360Profile[] = [
  {
    code: 'standard_360_system_admin',
    name: '360系统管理员',
    description: '可以查看、编辑所有评估活动，不受数据权限控制',
    objects: ALL.map((o) => grant(o)),
  },
  {
    code: 'standard_360_advanced_admin',
    name: '360高级管理员',
    description: '只能查看自己创建的和被授权的评估活动，不能编辑非本人创建的套卷',
    objects: ALL.map((o) => grant(o, ADVANCED_WITHOUT)),
  },
  {
    code: 'standard_360_general_admin',
    name: '360一般管理员',
    description: '同高级管理员，看不到“从系统管理中同步人员信息”',
    objects: ALL.map((o) => grant(o, [...ADVANCED_WITHOUT, SURVEY360_BUTTONS.sync])),
  },
];

import { defineTable, type PolicyBase } from '../../route-policy/index.js';
import {
  admin,
  all,
  BAD_REQUEST,
  fixed,
  noButton,
  none,
  noScope,
  object,
  write,
  type WriteExtra,
} from '../../route-policy/presets.js';
import { WELCOME_SETTINGS, WELCOME_WRITE_ALIAS } from './welcome-access.js';

const DEC = 'R2-T01 §9.2 / DEC-967 / DEC-983';
const noOrgScope = noScope('欢迎信与手册是租户级配置，按当前租户与任职设置授权读写');
const welcomeButton = noButton('BE16.WelcomeSettings 登记入口；配置对象由 other_settings 与字段操作权判定');
const handbookButton = noButton('BE16.HandbookSettings 登记入口；配置对象由 other_settings 与字段操作权判定');
const list = fixed(['items', 'availableActions'], DEC);
const actions = fixed(['availableActions'], DEC);
const receipt = fixed(['id', 'revision', 'status'], DEC);
const deleted = fixed([], 'R2-T01 §9.1 删除返回 204');
const welcomeDetail = fixed(
  ['id', 'name', 'title', 'body', 'variables', 'enabled', 'status', 'revision', 'availableActions'],
  DEC,
);
const handbookDetail = fixed(
  ['id', 'name', 'title', 'blocks', 'enabled', 'status', 'revision', 'availableActions'],
  DEC,
);
const welcomePreview = fixed(['title', 'bodyHtml'], DEC);
const handbookPreview = fixed(['title', 'blocks'], DEC);

type Operation = 'view' | 'create' | 'update';
type Fields = ReturnType<typeof fixed>;
type Button = typeof welcomeButton;

function operation(button: Button, op: Operation, fields: Fields, extra: PolicyBase = {}) {
  return object({ object: WELCOME_SETTINGS, operation: op, button, scope: noOrgScope, fields, ...extra });
}

function access(button: Button, op: Operation, fields: Fields, extra: PolicyBase = {}) {
  return all(
    [
      admin('other_settings', { ...(op === 'view' ? {} : { alias: WELCOME_WRITE_ALIAS }), fields }),
      operation(button, op, fields),
    ],
    fields,
    extra,
  );
}

function configWrite(guard: string, footprint: string, extra: WriteExtra = {}) {
  return write({ guard }, footprint, none('仅返回 id、revision、status，当前设置权由命令守卫复核'), {
    ledger: 'single',
    preconditions: ['assertRevision'],
    ...extra,
  });
}

/** 预览只读：合成样例纯渲染，不进命令台账，不写任何数据（§9.2）。 */
const previewWrite = (guard: string) =>
  write(
    { guard },
    none('只读预览：没有命令事务，没有提交前足迹'),
    none('只读预览：没有返回后复核，响应只含转义后的渲染结果'),
  );

function resource(button: Button, detail: Fields, rendered: Fields, guard: string, footprint: string) {
  const writeFor = () => configWrite(guard, footprint);
  return {
    list: access(button, 'view', list, { optional: { availableActions: operation(button, 'create', actions) } }),
    detail: access(button, 'view', detail, {
      invalidId: BAD_REQUEST,
      optional: { availableActions: operation(button, 'update', actions) },
    }),
    create: access(button, 'create', receipt, { write: writeFor() }),
    update: access(button, 'update', receipt, { invalidId: BAD_REQUEST, write: writeFor() }),
    archive: access(button, 'update', deleted, { invalidId: BAD_REQUEST, write: writeFor() }),
    preview: access(button, 'view', rendered, { invalidId: BAD_REQUEST, write: previewWrite(guard) }),
  };
}

const welcome = resource(
  welcomeButton,
  welcomeDetail,
  welcomePreview,
  'onboarding.welcomeLetterField',
  'config.audited:onboarding-welcome-letter',
);
const handbook = resource(
  handbookButton,
  handbookDetail,
  handbookPreview,
  'onboarding.handbookField',
  'config.audited:onboarding-handbook',
);

export const WELCOME_POLICIES = defineTable('onboarding', {
  'GET /welcome-letters': welcome.list,
  'GET /welcome-letters/:id': welcome.detail,
  'POST /welcome-letters': welcome.create,
  'PATCH /welcome-letters/:id': welcome.update,
  'DELETE /welcome-letters/:id': welcome.archive,
  'POST /welcome-letters/:id/preview': welcome.preview,
  'GET /handbooks': handbook.list,
  'GET /handbooks/:id': handbook.detail,
  'POST /handbooks': handbook.create,
  'PATCH /handbooks/:id': handbook.update,
  'DELETE /handbooks/:id': handbook.archive,
  'POST /handbooks/:id/preview': handbook.preview,
});

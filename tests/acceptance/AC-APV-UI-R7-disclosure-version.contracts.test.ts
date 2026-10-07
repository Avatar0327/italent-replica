/**
 * 第 7 轮（DEC-288 止损：后端兜底）：服务端为“查看人 × 实例”计算披露版本（表单字段集合、日志 / 任务历史可见字段名集合、
 * recordsHidden），完整详情、任务 / 日志历史每一页、写响应都带版本；客户端经 `x-disclosure-version` 回传最后看到的版本，
 * 当前披露更收紧时返回 409 + `DISCLOSURE_TIGHTENED`，响应体不带业务数据。普通 revision 冲突仍是 REVISION_CONFLICT。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { BASE, expectTightenedBody, placeScene, PLACE_VALUE, type PlaceScene } from './AC-APV-UI-R7-support.js';

const database = useTestDb();
const VERSION = 'x-disclosure-version';
const COMMENT = '合成首节点意见，转交进入隐藏节点后不得再出现';

interface Versioned {
  readonly disclosureVersion?: string;
  readonly recordsHidden?: boolean;
  readonly revision?: number;
  readonly items?: readonly { readonly event?: string; readonly comment?: string | null; readonly status?: string }[];
  readonly logs?: readonly { readonly event: string; readonly detail: { readonly fields?: string[] } }[];
  readonly form?: { readonly values: Readonly<Record<string, unknown>> };
}
type Options = { readonly version?: string; readonly ifMatch?: number; readonly body?: unknown; readonly key?: string };

function reader(scene: PlaceScene) {
  const get = (path: string, version?: string) =>
    scene.request(
      'GET',
      `${BASE}/instances/${scene.view.id}${path}`,
      version ? { headers: { [VERSION]: version } } : {},
    );
  const ok = async (path: string, version?: string): Promise<Versioned> => {
    const response = await get(path, version);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Versioned;
  };
  const versionOf = async (path = '') => {
    const value = (await ok(path)).disclosureVersion;
    expect(typeof value).toBe('string');
    expect(value!.length).toBeGreaterThan(0);
    return value!;
  };
  const tightened = async (path: string, version: string) => {
    const response = await get(path, version);
    expectTightenedBody(response.status, await response.json());
  };
  const post = (path: string, options: Options) =>
    scene.request('POST', `${BASE}${path}`, {
      ifMatch: options.ifMatch ?? scene.view.revision,
      body: options.body ?? {},
      ...(options.key ? { idempotencyKey: options.key } : {}),
      ...(options.version ? { headers: { [VERSION]: options.version } } : {}),
    });
  return { get, ok, versionOf, tightened, post };
}
const PAGES = [
  '/tasks?page=1&pageSize=20',
  '/tasks?page=2&pageSize=20',
  '/logs?page=1&pageSize=20',
  '/logs?page=2&pageSize=20',
];

describe('AC-APV-UI-02 / DEC-288 止损：披露版本随完整详情、每页历史与写响应返回', () => {
  it('同一查看人 × 实例：详情、任务 / 日志历史每一页返回同一版本；写响应带版本且与随后的详情一致', async () => {
    const scene = await placeScene(database().db, 'r7-version');
    const r = reader(scene);
    const version = await r.versionOf();
    for (const path of PAGES) expect((await r.ok(path)).disclosureVersion, path).toBe(version);
    const written = await r.post(`/tasks/${scene.task.id}/edit`, { body: { fields: { remarks: '合成编辑后备注' } } });
    expect(written.status, await written.clone().text()).toBe(200);
    const result = (await written.json()) as Versioned;
    expect(typeof result.disclosureVersion).toBe('string');
    expect(await r.versionOf()).toBe(result.disclosureVersion);
  });

  it('撤销 place 查看权后：带旧版本的完整详情 GET 返回 409 + DISCLOSURE_TIGHTENED 且无业务数据；不带版本或带新版本仍 200', async () => {
    const scene = await placeScene(database().db, 'r7-get');
    const r = reader(scene);
    const before = await r.ok('');
    expect(before.form?.values).toMatchObject({ place: PLACE_VALUE });
    const old = before.disclosureVersion!;
    await scene.revokePlace();
    await r.tightened('', old);
    const fresh = await r.ok('');
    expect(fresh.form?.values).not.toHaveProperty('place');
    expect(fresh.disclosureVersion).not.toBe(old);
    expect((await r.ok('', fresh.disclosureVersion)).form?.values).not.toHaveProperty('place');
  });

  it('每一页历史、每种历史类型都受保护：撤权后带旧版本请求任务 / 日志的第 1、2、3 页一律 409，不带版本则 200 且不含旧值', async () => {
    const scene = await placeScene(database().db, 'r7-pages');
    const r = reader(scene);
    const old = await r.versionOf('/tasks?page=1&pageSize=20');
    await scene.revokePlace();
    for (const kind of ['tasks', 'logs']) {
      for (const page of [1, 2, 3]) {
        const path = `/${kind}?page=${page}&pageSize=20`;
        await r.tightened(path, old);
        const fresh = await r.ok(path);
        expect(fresh.recordsHidden).toBe(false);
        expect(JSON.stringify(fresh)).not.toContain(PLACE_VALUE);
        expect(fresh.disclosureVersion).not.toBe(old);
      }
    }
  });

  it('切换历史类型：任务历史页拿到的版本用于日志历史请求（反之亦然），撤权后同样 409', async () => {
    const scene = await placeScene(database().db, 'r7-switch');
    const r = reader(scene);
    const fromTasks = await r.versionOf('/tasks?page=1&pageSize=20');
    const fromLogs = await r.versionOf('/logs?page=1&pageSize=20');
    await scene.revokePlace();
    await r.tightened('/logs?page=1&pageSize=20', fromTasks);
    await r.tightened('/tasks?page=1&pageSize=20', fromLogs);
  });

  it('覆盖范围不止最近 200 条：编辑日志被挤出详情窗口后，详情版本仍覆盖它，撤权后带旧版本的详情与深层分页都 409', async () => {
    const scene = await placeScene(database().db, 'r7-window');
    const r = reader(scene);
    const edited = await r.post(`/tasks/${scene.task.id}/edit`, { body: { fields: { place: '合成窗口外编辑地点' } } });
    expect(edited.status, await edited.clone().text()).toBe(200);
    await scene.padLogs(200);
    const detail = await r.ok('');
    expect(detail.logs?.some((log) => log.event === 'edit')).toBe(false);
    const deep = await r.ok('/logs?page=11&pageSize=20');
    expect(deep.items?.some((log) => log.event === 'edit')).toBe(true);
    expect(deep.disclosureVersion).toBe(detail.disclosureVersion);
    await scene.revokePlace();
    await r.tightened('', detail.disclosureVersion!);
    await r.tightened('/logs?page=11&pageSize=20', detail.disclosureVersion!);
    await r.tightened('/logs?page=1&pageSize=20', detail.disclosureVersion!);
    const after = await r.ok('/logs?page=11&pageSize=20');
    expect(JSON.stringify(after)).not.toContain('合成窗口外编辑地点');
  });

  it('写响应：撤权后带旧版本提交编辑，命令已执行并入台账，但响应是 409 + 原因码且无业务数据；同键不带版本重放得到 200 且不重复执行', async () => {
    const scene = await placeScene(database().db, 'r7-write');
    const r = reader(scene);
    const old = await r.versionOf();
    await scene.revokePlace();
    const key = randomUUID();
    const body = { fields: { remarks: '合成撤权后备注' } };
    const written = await r.post(`/tasks/${scene.task.id}/edit`, { body, key, version: old });
    expectTightenedBody(written.status, await written.json());
    const replay = await r.post(`/tasks/${scene.task.id}/edit`, { body, key });
    expect(replay.status, await replay.clone().text()).toBe(200);
    const result = (await replay.json()) as Versioned;
    expect(result.form?.values).toMatchObject({ remarks: '合成撤权后备注' });
    expect(result.form?.values).not.toHaveProperty('place');
    expect(result.revision).toBe(scene.view.revision + 1);
    expect(typeof result.disclosureVersion).toBe('string');
    const logs = await r.ok('/logs?page=1&pageSize=20');
    expect(logs.items?.filter((log) => log.event === 'edit')).toHaveLength(1);
  });

  it('recordsHidden 由 false 变 true（转交进入隐藏节点，DEC-115）：带转交前版本的详情与两种历史都 409，不带版本则隐藏且无旧意见', async () => {
    const scene = await placeScene(database().db, 'r7-hidden', { hiddenSecondNode: true });
    const r = reader(scene);
    const approved = await r.post(`/tasks/${scene.task.id}/approve`, { body: { comment: COMMENT } });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const view = (await approved.json()) as Versioned & {
      tasks: { id: string; status: string; assigneeUserId: string }[];
    };
    const old = await r.versionOf();
    expect(JSON.stringify(await r.ok(''))).toContain(COMMENT);
    const hiddenTask = view.tasks.find((task) => task.status === 'pending')!;
    expect(hiddenTask.assigneeUserId).toBe(scene.s.inHrbp.userId);
    const transferred = await scene.api.request('POST', `${BASE}/tasks/${hiddenTask.id}/transfer`, {
      ...scene.w.as(scene.s.inHrbp.userId),
      ifMatch: view.revision!,
      body: { toUserId: scene.viewer },
    });
    expect(transferred.status, await transferred.clone().text()).toBe(200);
    for (const path of ['', '/tasks?page=1&pageSize=20', '/logs?page=1&pageSize=20']) await r.tightened(path, old);
    for (const path of ['', '/tasks?page=1&pageSize=20', '/logs?page=1&pageSize=20']) {
      const fresh = await r.ok(path);
      expect(fresh.recordsHidden).toBe(true);
      expect(JSON.stringify(fresh)).not.toContain(COMMENT);
    }
  });

  it('只放宽不拒绝：先撤权再授予 place 查看权，带撤权时版本的请求仍 200（字段只增不减），版本随之变化', async () => {
    const scene = await placeScene(database().db, 'r7-loosen');
    const r = reader(scene);
    await scene.revokePlace();
    const narrow = await r.versionOf();
    await scene.grantPlace();
    const wide = await r.ok('', narrow);
    expect(wide.form?.values).toMatchObject({ place: PLACE_VALUE });
    expect(wide.disclosureVersion).not.toBe(narrow);
    for (const path of PAGES) expect((await r.ok(path, narrow)).disclosureVersion).toBe(wide.disclosureVersion);
  });

  it('版本格式非法 → 400 VALIDATION_FAILED + DISCLOSURE_VERSION_INVALID；普通 revision 冲突仍是 409 REVISION_CONFLICT', async () => {
    const scene = await placeScene(database().db, 'r7-codes');
    const r = reader(scene);
    const invalid = await r.get('', 'not-a-version');
    expect(invalid.status).toBe(400);
    const error = (await invalid.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(error.error.code).toBe('VALIDATION_FAILED');
    expect(error.error.details?.reason).toBe('DISCLOSURE_VERSION_INVALID');
    const current = await r.versionOf();
    const stale = await r.post(`/tasks/${scene.task.id}/edit`, {
      body: { fields: { remarks: '合成冲突备注' } },
      ifMatch: scene.view.revision + 7,
      version: current,
    });
    expect(stale.status).toBe(409);
    const conflict = (await stale.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(conflict.error.code).toBe('REVISION_CONFLICT');
    expect(conflict.error.details?.reason).toBeUndefined();
  });
});

/**
 * 第 7 轮（DEC-288 止损：后端兜底）端到端：真实 React 组件直接驱动真实 Hono 应用（PGlite + 生产授权器）。
 * 服务端在披露收紧时返回 409 + DISCLOSURE_TIGHTENED 且不带业务数据；前端立即清空详情 / 历史 / 表单并整页刷新；
 * 刷新前把已发出 / 结果未知的命令存入 sessionStorage，刷新后按原键先回查再重试，已执行的写操作不重复执行。
 * 覆盖第 6 轮审查三条路径（排队读取、跨页、切换历史类型）、GET / POST / 每一页历史，以及 P2-2 草稿清理。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASE,
  expectTightenedBody,
  header,
  mountWorkspace,
  placeScene,
  PLACE_VALUE,
  realFetch,
  registerDom,
  releaseDom,
  snapshot,
  type Exchange,
  type Mounted,
  type PlaceScene,
  type RealFetch,
} from './AC-APV-UI-R7-support.js';

const database = useTestDb();
const VERSION = 'x-disclosure-version';
const OTHER_TAB_VALUE = '合成另一标签页编辑后地点';
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  registerDom();
  reload = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  releaseDom();
});

interface Session {
  readonly net: RealFetch;
  readonly ui: Mounted;
  /** 自 409 交付起的 Profiler 帧序号。 */
  mark: number;
}
async function open(scene: PlaceScene, options: { instanceId?: string | null; ready?: string } = {}): Promise<Session> {
  const { app, secret } = scene.app();
  const net = realFetch(app, secret, scene.viewer);
  const session: Session = { net, ui: null as unknown as Mounted, mark: -1 };
  net.onDeliver = (exchange) => {
    if (exchange.status === 409) session.mark = session.ui.frames.length;
  };
  const instanceId = options.instanceId === null ? {} : { instanceId: options.instanceId ?? scene.view.id };
  session.ui = await mountWorkspace({ tenantId: scene.w.tenant.id, ...instanceId, reload });
  const ready = options.ready ?? PLACE_VALUE;
  await session.ui.until(() => snapshot(session.ui.host).includes(ready), `详情显示 ${ready}`);
  return session;
}
function detailUrl(scene: PlaceScene) {
  return `${BASE}/instances/${scene.view.id}`;
}
function last(net: RealFetch): Exchange {
  return net.exchanges.at(-1)!;
}
/** 最近一次写请求（写成功后列表会刷新，最后一次往返未必是写）。 */
function lastPost(net: RealFetch): Exchange {
  return net.exchanges.filter((exchange) => exchange.options.method === 'POST').at(-1)!;
}
/** 等待某个历史页请求返回并渲染完毕（页码已显示、历史按钮不再 busy）。 */
async function awaitPage({ net, ui }: Session, kind: 'tasks' | 'logs', page: number) {
  await ui.until(
    () =>
      last(net).url.includes(`/${kind}?page=${page}`) &&
      (ui.panel().textContent?.includes(`第 ${page} 页`) ?? false) &&
      ui.buttons().some((button) => button.textContent === '查看日志历史' && !button.disabled),
    `${kind} 第 ${page} 页渲染完成`,
  );
}
/** 收到 409 之后的每一次 DOM 提交都不再含旧字段名 / 旧值；面板只剩占位；整页刷新恰好一次。 */
function expectClearedAndReloaded({ ui, mark }: Session, ...words: string[]) {
  expect(mark).toBeGreaterThanOrEqual(0);
  const since = ui.frames.slice(mark);
  expect(since.length).toBeGreaterThan(0);
  for (const [index, frame] of since.entries())
    for (const word of ['place', PLACE_VALUE, ...words]) expect(frame, `commit #${mark + index}`).not.toContain(word);
  expect(ui.panel().querySelector('.approval-summary')).toBeNull();
  expect(ui.panel().querySelector('.approval-history')).toBeNull();
  expect(ui.panel().querySelector('input, textarea')).toBeNull();
  expect(reload).toHaveBeenCalledTimes(1);
}
async function awaitReload(session: Session) {
  await session.ui.until(() => reload.mock.calls.length > 0, '整页刷新');
}
function versionOf(exchange: Exchange) {
  const value = (exchange.body as { disclosureVersion?: string }).disclosureVersion;
  expect(typeof value).toBe('string');
  return value!;
}

describe('第 6 轮审查三条路径：服务端返回原因码、响应体无业务数据、前端清空并整页刷新', () => {
  it('排队读取：刷新在途时排队的日志请求回传新详情的版本（而非排队前的旧详情）；撤权后服务端 409，前端清空并刷新', async () => {
    const scene = await placeScene(database().db, 'r7-e2e-queued');
    const session = await open(scene);
    const { net, ui } = session;
    // 另一标签页：本人编辑 place → 产生字段名为 [place] 的新编辑日志。
    const edited = await scene.request('POST', `${BASE}/tasks/${scene.task.id}/edit`, {
      ifMatch: scene.view.revision,
      body: { fields: { place: OTHER_TAB_VALUE } },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    // 刷新详情：服务端已算出含新编辑日志的详情，交付挂起；日志历史随后排队（通道串行，不发出）。
    const gate = net.hold((url, options) => options.method !== 'POST' && url === detailUrl(scene));
    await ui.click('刷新详情');
    await gate.held;
    const sent = net.exchanges.length;
    await ui.click('查看日志历史');
    expect(net.exchanges.length).toBe(sent);
    // 撤权后放行旧详情：组件采纳新详情，排队的日志请求带新详情的版本发出。
    await scene.revokePlace();
    gate.release();
    await awaitReload(session);
    const detail = net.exchanges.find(
      (item) => item.url === detailUrl(scene) && item.status === 200 && item !== net.exchanges[0],
    );
    expect(detail).toBeTruthy();
    expect(JSON.stringify(detail!.body)).toContain(OTHER_TAB_VALUE);
    const logs = last(net);
    expect(logs.url).toContain('/logs?');
    expect(header(logs.options, VERSION)).toBe(versionOf(detail!));
    expectTightenedBody(logs.status, logs.body);
    expectClearedAndReloaded(session, OTHER_TAB_VALUE);
  });

  it('跨页：编辑日志在详情最近 200 条之外；翻到第 2 页后撤权，回到第 1 页的请求带第 2 页的版本 → 409，前端清空并刷新', async () => {
    const scene = await placeScene(database().db, 'r7-e2e-pages');
    const edited = await scene.request('POST', `${BASE}/tasks/${scene.task.id}/edit`, {
      ifMatch: scene.view.revision,
      body: { fields: { place: PLACE_VALUE } },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    await scene.padLogs(200);
    const session = await open(scene);
    const { net, ui } = session;
    expect(JSON.stringify(net.exchanges[0]!.body)).not.toContain('"edit"');
    await ui.click('查看日志历史');
    await awaitPage(session, 'logs', 1);
    await ui.click('下一页');
    await awaitPage(session, 'logs', 2);
    const page2 = last(net);
    expect(page2.status).toBe(200);
    await scene.revokePlace();
    await ui.click('上一页');
    await awaitReload(session);
    const back = last(net);
    expect(back.url).toContain('/logs?page=1');
    expect(header(back.options, VERSION)).toBe(versionOf(page2));
    expectTightenedBody(back.status, back.body);
    expectClearedAndReloaded(session);
  });

  it('切换历史类型：日志页 → 任务页后撤权，再回日志页的请求带任务页的版本 → 409，前端清空并刷新', async () => {
    const scene = await placeScene(database().db, 'r7-e2e-switch');
    const session = await open(scene);
    const { net, ui } = session;
    await ui.click('查看日志历史');
    await awaitPage(session, 'logs', 1);
    await ui.click('查看任务历史');
    await awaitPage(session, 'tasks', 1);
    const tasks = last(net);
    expect(tasks.status).toBe(200);
    await scene.revokePlace();
    await ui.click('查看日志历史');
    await awaitReload(session);
    const logs = last(net);
    expect(logs.url).toContain('/logs?page=1');
    expect(header(logs.options, VERSION)).toBe(versionOf(tasks));
    expectTightenedBody(logs.status, logs.body);
    expectClearedAndReloaded(session);
  });
});

describe('GET / POST / 每一页历史各至少一例', () => {
  it('GET：撤权后手动刷新详情回传首载版本 → 409 原因码且无业务数据；前端清空并整页刷新', async () => {
    const scene = await placeScene(database().db, 'r7-e2e-get');
    const session = await open(scene);
    const { net, ui } = session;
    const first = net.exchanges[0]!;
    expect(header(first.options, VERSION)).toBeNull();
    await scene.revokePlace();
    await ui.click('刷新详情');
    await awaitReload(session);
    const refresh = last(net);
    expect(refresh.url).toBe(detailUrl(scene));
    expect(header(refresh.options, VERSION)).toBe(versionOf(first));
    expectTightenedBody(refresh.status, refresh.body);
    expectClearedAndReloaded(session);
  });

  it('POST：撤权后转交，命令已执行但响应 409；刷新前命令存入 sessionStorage，刷新后按原键回查并重试，服务端重放不重复执行', async () => {
    const scene = await placeScene(database().db, 'r7-e2e-post');
    const session = await open(scene);
    const { net, ui } = session;
    const first = net.exchanges[0]!;
    await scene.revokePlace();
    await ui.click('转交');
    await ui.input('接收人用户账号 ID', scene.s.inHrbp.userId);
    await ui.input('审批意见', '合成转交意见');
    await ui.click('确认提交');
    await awaitReload(session);
    const write = lastPost(net);
    expect(last(net)).toBe(write);
    expect(write.url).toBe(`${BASE}/tasks/${scene.task.id}/transfer`);
    expect(header(write.options, VERSION)).toBe(versionOf(first));
    expectTightenedBody(write.status, write.body);
    expectClearedAndReloaded(session, '合成转交意见');
    const key = header(write.options, 'idempotency-key')!;
    expect(sessionStorage.length).toBe(1);
    const stored = sessionStorage.getItem(sessionStorage.key(0)!)!;
    for (const piece of [key, `/tasks/${scene.task.id}/transfer`, String(scene.view.revision), scene.s.inHrbp.userId])
      expect(stored).toContain(piece);

    // 整页刷新：深链不带实例时也按暂存命令回到原单；回查用完整详情（无版本头），再以原键重试 → 台账重放 200。
    await ui.unmount();
    const again = await open(scene, { instanceId: null, ready: '操作编号' });
    await again.ui.until(
      () => again.ui.buttons().some((b) => b.textContent === '重试原命令' && !b.disabled),
      '回查完成',
    );
    const recheck = again.net.exchanges[0]!;
    expect(recheck.url).toBe(detailUrl(scene));
    expect(header(recheck.options, VERSION)).toBeNull();
    expect(JSON.stringify(recheck.body)).not.toContain(PLACE_VALUE);
    await again.ui.click('重试原命令');
    await again.ui.until(() => again.ui.host.textContent?.includes('操作已完成') ?? false, '重试完成');
    const retry = lastPost(again.net);
    expect(retry.url).toBe(write.url);
    expect(retry.options.body).toEqual(write.options.body);
    expect(header(retry.options, 'idempotency-key')).toBe(key);
    expect(header(retry.options, 'if-match')).toBe(header(write.options, 'if-match'));
    expect(retry.status).toBe(200);
    expect(sessionStorage.length).toBe(0);
    expect(again.ui.buttons().some((b) => b.textContent === '重试原命令')).toBe(false);
    // 服务端只执行了一次转交：任务历史恰有一条 transferred，实例 revision 只推进一次。
    const tasks = await scene.request('GET', `${BASE}/instances/${scene.view.id}/tasks?page=1&pageSize=20`);
    const page = (await tasks.json()) as { items: { status: string }[] };
    expect(page.items.filter((task) => task.status === 'transferred')).toHaveLength(1);
    expect((retry.body as { revision: number }).revision).toBe(scene.view.revision + 1);
  });

  it('每一页历史：日志第 2 页后撤权再翻到第 3 页 → 409；任务第 1 页后撤权再查看任务历史 → 409', async () => {
    const scene = await placeScene(database().db, 'r7-e2e-each-page');
    await scene.padLogs(45);
    const session = await open(scene);
    const { net, ui } = session;
    await ui.click('查看日志历史');
    await awaitPage(session, 'logs', 1);
    await ui.click('下一页');
    await awaitPage(session, 'logs', 2);
    const page2 = last(net);
    await scene.revokePlace();
    await ui.click('下一页');
    await awaitReload(session);
    const page3 = last(net);
    expect(page3.url).toContain('/logs?page=3');
    expect(header(page3.options, VERSION)).toBe(versionOf(page2));
    expectTightenedBody(page3.status, page3.body);
    expectClearedAndReloaded(session);
    await ui.unmount();

    reload.mockClear();
    const other = await placeScene(database().db, 'r7-e2e-tasks-page');
    const second = await open(other);
    await second.ui.click('查看任务历史');
    await awaitPage(second, 'tasks', 1);
    const tasks = last(second.net);
    await other.revokePlace();
    await second.ui.click('查看任务历史');
    await awaitReload(second);
    const again = last(second.net);
    expect(again.url).toContain('/tasks?page=1');
    expect(header(again.options, VERSION)).toBe(versionOf(tasks));
    expectTightenedBody(again.status, again.body);
    expectClearedAndReloaded(second);
  });
});

describe('P2-2：命令确认成功时清除展示草稿', () => {
  it('保存 place=A 成功 → 另一标签页改成 B → 本页刷新后只改 remarks → 提交载荷不含 place，服务端 place 仍为 B', async () => {
    const scene = await placeScene(database().db, 'r7-e2e-draft', { hiddenFirstNode: true });
    const session = await open(scene);
    const { net, ui } = session;
    await ui.input('place', '合成地点A');
    await ui.click('编辑');
    await ui.click('确认提交');
    await ui.until(() => ui.host.textContent?.includes('操作已完成') ?? false, '第一次编辑完成');
    const first = lastPost(net);
    expect(first.status).toBe(200);
    expect(JSON.parse(String(first.options.body))).toEqual({ fields: { place: '合成地点A' } });
    const revision = (first.body as { revision: number }).revision;
    // 另一标签页（同一审批人）合法改为 B。
    const other = await scene.request('POST', `${BASE}/tasks/${scene.task.id}/edit`, {
      ifMatch: revision,
      body: { fields: { place: '合成地点B' } },
    });
    expect(other.status, await other.clone().text()).toBe(200);
    const reads = net.exchanges.filter((item) => item.url === detailUrl(scene)).length;
    await ui.click('刷新详情');
    await ui.until(
      () =>
        net.exchanges.filter((item) => item.url === detailUrl(scene)).length > reads &&
        !(ui.panel().textContent?.includes('正在读取审批信息') ?? false),
      '刷新完成',
    );
    expect(ui.host.querySelector<HTMLInputElement>('[aria-label="place"]')?.value).toBe('合成地点B');
    await ui.input('remarks', '合成新备注');
    await ui.click('编辑');
    await ui.click('确认提交');
    await ui.until(() => lastPost(net) !== first, '第二次提交');
    await ui.until(() => ui.host.textContent?.includes('操作已完成') ?? false, '第二次编辑完成');
    const second = lastPost(net);
    expect(JSON.parse(String(second.options.body))).toEqual({ fields: { remarks: '合成新备注' } });
    expect(second.status).toBe(200);
    expect((second.body as { form: { values: Record<string, unknown> } }).form.values).toMatchObject({
      place: '合成地点B',
      remarks: '合成新备注',
    });
    expect(reload).not.toHaveBeenCalled();
  });
});

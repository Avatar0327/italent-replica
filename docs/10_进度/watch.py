#!/usr/bin/env python3
"""进度窗口的 GitHub 监控：每 3 分钟查一次在途 PR，有事件就打印并退出（由进度窗口处理后重启）。

事件：新开 PR、转 Ready、CI 变红、合并或关闭、停摆、本机 ChatGPT 审查会话出结论 → 退出提醒；新推送、CI 变绿、新评论只记到 ~/.cache/italent-progress-watch.log（省 token）。
Opus 审查待收：PR 上有“审查已发起”（Opus / claude.ai/code）评论、其后 OPUS_REMIND 分钟无审查原文 / 结论 → 提醒（本机看不到云端会话）。
待送审：最新提交 READY 分钟后 CI 绿（或无 CI）、提交后无送审类评论 → 提醒（覆盖云端开发会话完成看不到的问题）。
单实例：pid 文件，新实例结束旧实例；事件同时追加到 ~/.cache/italent-progress-watch.events。
停摆：CI 全绿 + 最新提交与最新评论都早于 STALL 分钟 → 视为“开发方已停、没人送审或没人处理结论”。
状态存在 STATE 文件里，重启不丢基线；已报过的停摆同一 head 只报一次。
"""
import json, os, subprocess, sys, time, datetime

STATE = os.path.expanduser("~/.cache/italent-progress-watch.json")
INTERVAL = 180
STALL = 90  # 分钟（审查发起时编排会在 PR 贴一行评论，据此区分在审与停摆）
READY = 10  # 分钟：提交后这么久、CI 绿（或无 CI）且无送审评论 → 提醒审查合并窗口
READY_DRAFT = 45  # Draft 多为开发中，门槛放宽
OPUS_REMIND = 60  # 分钟：claude.ai/code 的 Opus 审查会话本机看不到，发起后这么久 PR 上仍无“审查原文 / 结论”就提醒去看会话，之后每 60 分钟再提醒


def gh(args):
    r = subprocess.run(["gh"] + args, capture_output=True, text=True, timeout=90, cwd=os.path.expanduser("~/Code/wt-progress"))
    if r.returncode or not r.stdout.strip():
        raise RuntimeError(r.stderr.strip()[:200] or "gh 无输出")
    return json.loads(r.stdout)


def snapshot():
    prs = gh(["pr", "list", "--state", "open", "--json", "number,title,headRefOid,isDraft,statusCheckRollup,comments,commits"])
    out = {}
    for p in prs:
        checks = [c.get("conclusion") or c.get("status") for c in p["statusCheckRollup"] if c.get("conclusion") != "SKIPPED"]
        ci = "none" if not checks else "green" if checks and all(c == "SUCCESS" for c in checks) else ("red" if any(c in ("FAILURE", "CANCELLED", "TIMED_OUT") for c in checks) else "running")
        last_commit = p["commits"][-1]["committedDate"] if p["commits"] else ""
        last_comment = p["comments"][-1]["createdAt"] if p["comments"] else ""
        opus = ""  # 最近一次 Opus（claude.ai/code）审查发起时间；其后出现审查原文 / 结论评论即清空
        for c in p["comments"]:
            b = c.get("body", "")
            if "审查已发起" in b and ("claude.ai/code" in b or "Opus" in b):
                opus = c["createdAt"]
            elif opus and ("审查原文" in b or "结论" in b[:200]):
                opus = ""
        lc = p["commits"][-1]["committedDate"] if p["commits"] else ""
        handled = any(c["createdAt"] > lc and any(w in c.get("body", "") for w in ("审查已发起", "排队待审", "修改清单", "审查原文", "勿改动", "待合并", "已发起"))
                      for c in p["comments"])
        out[str(p["number"])] = {"opus": opus, "handled": handled, "t": p["title"][:40], "head": p["headRefOid"][:7], "draft": p["isDraft"], "ci": ci,
                                 "commit": last_commit, "comment": last_comment, "nc": len(p["comments"])}
    return out


def codex_results():
    """本机 ChatGPT 应用的审查会话：统计每个会话文件里 task_complete 的次数，并从内容中认出 PR 号。"""
    import glob, re
    out = {}
    cutoff = time.time() - 3 * 86400
    for f in glob.glob(os.path.expanduser("~/.codex/sessions/*/*/*/*.jsonl")):
        if os.path.getmtime(f) < cutoff:
            continue
        try:
            txt = open(f, encoding="utf8", errors="ignore").read()
        except OSError:
            continue
        if "italent" not in txt:
            continue  # 其他项目的 ChatGPT 会话
        head = txt.split("\n", 1)[0]
        if '"forked_from_id":"' in head or '"parent_thread_id":"' in head:
            continue  # 审查会话 fork 出的子线程，不算结论
        if "thread_spawn" in head:
            continue  # 子代理线程，不算结论（只认主线程）
        n = txt.count('"task_complete"')
        m = re.search(r"italent-replica/pull/(\d+)|wt-(\d+)", txt)
        pr = (m.group(1) or m.group(2)) if m else "?"
        out[os.path.basename(f)[-41:-6]] = [n, pr]
    return out


EVIDENCE_IDLE = 60  # 分钟：取证窗口（提交信息以“取证：”开头）这么久没有新提交 → 提醒（用户 10-07 要求取证不停）


def last_evidence_commit():
    """origin/main 上最近一条“取证：”提交的时间（ISO），取不到返回空。"""
    try:
        subprocess.run(["git", "fetch", "-q"], cwd=os.path.expanduser("~/Code/wt-progress"), timeout=60)
        r = subprocess.run(["git", "log", "origin/main", "-1", "--format=%cI", "--grep=^取证："], capture_output=True, text=True,
                           timeout=30, cwd=os.path.expanduser("~/Code/wt-progress"))
        return r.stdout.strip()
    except Exception:
        return ""


def mins_since(iso):
    if not iso:
        return 1e9
    t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() / 60


def single_instance():
    """只允许一个 watcher：新实例启动时结束旧实例（防止 TaskStop 只杀外壳、Python 成孤儿继续吞事件）。"""
    pidf = os.path.expanduser("~/.cache/italent-progress-watch.pid")
    try:
        old = int(open(pidf).read().strip())
        if old != os.getpid():
            os.kill(old, 15)
            time.sleep(1)
    except Exception:
        pass
    open(pidf, "w").write(str(os.getpid()))
    return pidf


def main():
    pidf = single_instance()
    old = {}
    if os.path.exists(STATE):
        old = json.load(open(STATE))
    prev, stalled = old.get("prs"), set(old.get("stalled", []))
    cprev = old.get("codex")
    while True:
        try:
            if int(open(pidf).read().strip()) != os.getpid():
                sys.exit(0)  # 已有更新的实例接管
        except Exception:
            pass
        try:
            cur = snapshot()
        except Exception:
            time.sleep(INTERVAL)  # gh 临时失败：跳过本轮，避免误报“全部已关闭”
            continue
        if prev and not cur and len(prev) > 2:
            time.sleep(INTERVAL)  # 一次性全部消失视为接口异常，下一轮再确认
            continue
        ev = []
        if prev is not None:
            for n, p in cur.items():
                o = prev.get(n)
                if not o:
                    ev.append(f"新 PR #{n} {p['t']}（{'Draft' if p['draft'] else 'Ready'}）")
                    continue
                if p["head"] != o["head"]:
                    ev.append(f"#{n} 新推送 {p['head']}")
                if p["ci"] != o["ci"] and p["ci"] not in ("running", "none"):
                    ev.append(f"#{n} CI {p['ci']}（{p['head']}）")
                if p["nc"] > o["nc"]:
                    ev.append(f"#{n} 新评论 {p['nc'] - o['nc']} 条")
                if o["draft"] and not p["draft"]:
                    ev.append(f"#{n} 转为 Ready")
            for n in prev:
                if n not in cur:
                    ev.append(f"#{n} 已合并或关闭")
        cx = codex_results()
        if cprev is not None:
            for k, (cnt, pr) in cx.items():
                if cnt > cprev.get(k, [0, pr])[0]:
                    ev.append(f"本机 ChatGPT 会话完成 #{pr}（{k[-12:]}，第 {cnt} 次；审查会话即出了结论，开发任务即已停下）")
        cprev = cx
        for n, p in cur.items():
            key = f"{n}@{p['head']}@{p['nc']}"
            if p["ci"] == "green" and not p["draft"] and mins_since(p["commit"]) > STALL and mins_since(p["comment"]) > STALL and key not in stalled:
                ev.append(f"停摆 #{n} {p['t']}：CI 绿，最新提交 {int(mins_since(p['commit']))} 分钟前，{STALL} 分钟内无评论")
                stalled.add(key)
            k2 = f"{n}@ready@{p['head']}"
            if p["ci"] in ("green", "none") and mins_since(p["commit"]) >= (READY_DRAFT if p["draft"] else READY) and not p.get("handled") and k2 not in stalled:
                ev.append(f"待送审 #{n} {p['t']}：最新提交 {p['head']} 已 {int(mins_since(p['commit']))} 分钟、CI {'绿' if p['ci'] == 'green' else '无'}，提交后 PR 上没有审查发起 / 排队 / 修改清单评论——开发方可能已完成，请确认并发起审查")
                stalled.add(k2)
            if p.get("opus"):
                m = int(mins_since(p["opus"]))
                k = f"{n}@opus@{p['opus']}@{m // OPUS_REMIND}"
                if m >= OPUS_REMIND and k not in stalled:
                    ev.append(f"Opus 审查待收 #{n} {p['t']}：claude.ai/code 审查会话发起 {m} 分钟，PR 上仍无审查原文 / 结论，请审查合并窗口看会话是否已完成或卡住")
                    stalled.add(k)
        ev_t = last_evidence_commit()
        if ev_t:
            m = int(mins_since(ev_t))
            k3 = f"evidence-idle@{ev_t}@{m // EVIDENCE_IDLE}"
            if m >= EVIDENCE_IDLE and k3 not in stalled:
                ev.append(f"取证停顿：取证窗口最近一次“取证：”提交在 {m} 分钟前，请确认是否卡住、是否在等用户操作")
                stalled.add(k3)
        open(os.path.expanduser("~/.cache/italent-progress-watch.beat"), "w").write(datetime.datetime.now().isoformat())
        json.dump({"prs": cur, "stalled": sorted(stalled)[-200:], "codex": cprev}, open(STATE, "w"))
        quiet = [e for e in ev if (" 新推送 " in e or " CI green" in e or " 新评论 " in e)]
        loud = [e for e in ev if e not in quiet]
        if quiet:
            with open(os.path.expanduser("~/.cache/italent-progress-watch.log"), "a") as f:
                f.write(datetime.datetime.now().strftime("%m-%d %H:%M ") + "；".join(quiet) + "\n")
        ev = loud
        if ev:
            with open(os.path.expanduser("~/.cache/italent-progress-watch.events"), "a") as f:
                f.write(datetime.datetime.now().strftime("%m-%d %H:%M ") + "；".join(ev) + "\n")
            print(datetime.datetime.now().strftime("%m-%d %H:%M"), "\n".join(ev))
            sys.exit(0)
        prev = cur
        time.sleep(INTERVAL)


if __name__ == "__main__":
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    main()

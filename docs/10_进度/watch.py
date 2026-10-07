#!/usr/bin/env python3
"""进度窗口的 GitHub 监控：每 3 分钟查一次在途 PR，有事件就打印并退出（由进度窗口处理后重启）。

事件：新开 PR、新推送、CI 变绿 / 变红、新评论（审查结论 / 修改清单）、合并或关闭。
停摆：CI 全绿 + 最新提交与最新评论都早于 STALL 分钟 → 视为“开发方已停、没人送审或没人处理结论”。
状态存在 STATE 文件里，重启不丢基线；已报过的停摆同一 head 只报一次。
"""
import json, os, subprocess, sys, time, datetime

STATE = os.path.expanduser("~/.cache/italent-progress-watch.json")
INTERVAL = 180
STALL = 90  # 分钟（审查发起时编排会在 PR 贴一行评论，据此区分在审与停摆）


def gh(args):
    r = subprocess.run(["gh"] + args, capture_output=True, text=True, cwd=os.path.expanduser("~/Code/wt-progress"))
    return json.loads(r.stdout or "[]")


def snapshot():
    prs = gh(["pr", "list", "--state", "open", "--json", "number,title,headRefOid,isDraft,statusCheckRollup,comments,commits"])
    out = {}
    for p in prs:
        checks = [c.get("conclusion") or c.get("status") for c in p["statusCheckRollup"] if c.get("conclusion") != "SKIPPED"]
        ci = "green" if checks and all(c == "SUCCESS" for c in checks) else ("red" if any(c in ("FAILURE", "CANCELLED", "TIMED_OUT") for c in checks) else "running")
        last_commit = p["commits"][-1]["committedDate"] if p["commits"] else ""
        last_comment = p["comments"][-1]["createdAt"] if p["comments"] else ""
        out[str(p["number"])] = {"t": p["title"][:40], "head": p["headRefOid"][:7], "draft": p["isDraft"], "ci": ci,
                                 "commit": last_commit, "comment": last_comment, "nc": len(p["comments"])}
    return out


def mins_since(iso):
    if not iso:
        return 1e9
    t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() / 60


def main():
    old = {}
    if os.path.exists(STATE):
        old = json.load(open(STATE))
    prev, stalled = old.get("prs"), set(old.get("stalled", []))
    while True:
        cur = snapshot()
        ev = []
        if prev is not None:
            for n, p in cur.items():
                o = prev.get(n)
                if not o:
                    ev.append(f"新 PR #{n} {p['t']}（{'Draft' if p['draft'] else 'Ready'}）")
                    continue
                if p["head"] != o["head"]:
                    ev.append(f"#{n} 新推送 {p['head']}")
                if p["ci"] != o["ci"] and p["ci"] != "running":
                    ev.append(f"#{n} CI {p['ci']}（{p['head']}）")
                if p["nc"] > o["nc"]:
                    ev.append(f"#{n} 新评论 {p['nc'] - o['nc']} 条")
                if o["draft"] and not p["draft"]:
                    ev.append(f"#{n} 转为 Ready")
            for n in prev:
                if n not in cur:
                    ev.append(f"#{n} 已合并或关闭")
        for n, p in cur.items():
            key = f"{n}@{p['head']}@{p['nc']}"
            if p["ci"] == "green" and not p["draft"] and mins_since(p["commit"]) > STALL and mins_since(p["comment"]) > STALL and key not in stalled:
                ev.append(f"停摆 #{n} {p['t']}：CI 绿，最新提交 {int(mins_since(p['commit']))} 分钟前，{STALL} 分钟内无评论")
                stalled.add(key)
        json.dump({"prs": cur, "stalled": sorted(stalled)[-200:]}, open(STATE, "w"))
        if ev:
            print(datetime.datetime.now().strftime("%m-%d %H:%M"), "\n".join(ev))
            sys.exit(0)
        prev = cur
        time.sleep(INTERVAL)


if __name__ == "__main__":
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    main()

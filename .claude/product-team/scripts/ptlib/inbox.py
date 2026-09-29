"""The owner's single to-do list: one pinned issue whose body every run rewrites from the backlog."""
from __future__ import annotations

from typing import Dict, List

MARKER = "<!-- pt-inbox -->"

# key -> (title, the one action the owner takes), per owner language
TEXT: Dict[str, Dict[str, tuple]] = {
    "en": {
        "setup": ("Security setup", "Until this is done, agents can imitate your approvals"),
        "paused": ("Team is paused", "Check the failed runs, then comment `/resume` on the run log"),
        "release": ("Release decision", "On the demo issue: `/go` or `/no-go why`"),
        "design": ("Designs to approve", "Open the link, then `/approve` or `/reject why` on the issue"),
        "question": ("Questions", "Each line says what to answer"),
        "owner": ("Only you can do", "Payment, account or decision described on the issue"),
        "local": ("Needs your machine", "Run locally (e.g. on a Mac); the issue says what"),
        "fyi": ("Decided by the team (FYI)", "Nothing to do; `/reject why` on the issue reverses it"),
        "count": ("{n} thing needs you.", "{n} things need you."),
        "updated": "Updated {when} by the product team; rewritten every run.",
        "none": "Nothing needs you right now.",
    },
    "ru": {
        "setup": ("Безопасность", "Пока это не сделано, агенты могут изобразить твоё одобрение"),
        "paused": ("Команда на паузе", "Посмотри упавшие запуски и напиши `/resume` в журнале запусков"),
        "release": ("Решение о релизе", "В issue демо: `/go` или `/no-go причина`"),
        "design": ("Дизайн на утверждение", "Открой ссылку, затем `/approve` или `/reject причина` в issue"),
        "question": ("Вопросы", "В каждой строке написано, что ответить"),
        "owner": ("Только ты можешь", "Оплата, аккаунт или решение — описано в issue"),
        "local": ("Нужен твой компьютер", "Запустить локально (например, на Mac); что именно — в issue"),
        "fyi": ("Решено командой (к сведению)", "Делать ничего не нужно; `/reject причина` в issue отменит"),
        "count": ("Нужно твоё внимание: {n}.", "Нужно твоё внимание: {n}."),
        "updated": "Обновлено {when}; переписывается каждым запуском.",
        "none": "Сейчас от тебя ничего не нужно.",
    },
}
ORDER = ("setup", "paused", "release", "design", "question", "owner", "local")


def classify(issue: dict):
    labels = set(issue.get("labels") or [])
    if "team:demo" in labels:
        return "release"
    if "design:awaiting-approval" in labels:
        return "design"
    if "needs:owner" in labels and issue.get("kind") != "question":
        return "owner"
    if issue.get("kind") == "question":
        return "question"
    if "needs:local" in labels:
        return "local"
    return None


def sections(issues: List[dict], paused_url: str = "", same_account_url: str = "", decided: List[dict] = ()) -> Dict[str, list]:
    groups: Dict[str, list] = {key: [] for key in ORDER + ("fyi",)}
    if same_account_url:
        groups["setup"].append({"title": "Agents use your GitHub account — add a reviewing account and "
                                         "team.reviewer_logins", "url": same_account_url})
    if paused_url:
        groups["paused"].append({"title": "Run log", "url": paused_url})
    for issue in sorted(issues, key=lambda i: i["number"]):
        key = classify(issue)
        if key:
            groups[key].append(issue)
    groups["fyi"] = list(decided)[:5]
    return groups


def item_line(item: dict) -> str:
    number = f"#{item['number']} " if "number" in item else ""
    ask = f" — {item['ask']}" if item.get("ask") else ""
    return f"- {number}[{item['title']}]({item['url']}){ask}"


def render(issues: List[dict], paused_url: str = "", updated: str = "", same_account_url: str = "",
           decided: List[dict] = (), language: str = "en") -> str:
    """same_account_url: link to the owner checklist, set while the agents act as the owner's account."""
    t = TEXT.get(language, TEXT["en"])
    groups = sections(issues, paused_url, same_account_url, decided)
    total = sum(len(groups[k]) for k in ORDER)
    lines = [MARKER, f"**{t['count'][0 if total == 1 else 1].format(n=total)}** {t['updated'].format(when=updated)}", ""]
    if not total:
        lines.append(t["none"])
    for key in ORDER + ("fyi",):
        items = groups[key]
        if not items:
            continue
        title, action = t[key]
        lines += [f"### {title} ({len(items)})", f"_{action}_", ""]
        lines += [item_line(item) for item in items]
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"

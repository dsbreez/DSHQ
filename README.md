# HQ

Your own team of AI managers, on one screen, on your own Mac.

HQ is a small local app that sits on top of Claude Code. You set up a few **managers**, one per area of your work (web, content, growth, research, whatever you own). Each manager keeps one ongoing conversation with you and a **desk**: a short file of what it's working on, what it's waiting on you for, and what you've decided together. Bigger jobs go to background **workers**, which come back to you for a yes, a no, or a note.

Everything runs on your computer with your own Claude plan. Nothing is hosted, and nothing leaves your machine without your OK.

## What you get

- **A dashboard.** Your day in one sentence, the questions your managers need answered (one tap: Yes, No, a choice, or a reply), work ready for review, what's running now, and your projects in one line each.
- **Managers.** One conversation each that never resets, with its desk beside it. Pick each manager's model and effort.
- **Workers.** Background tasks that report back with a short card: the copy to paste, the asset it needs, why. Approve, approve with context, or send back with a note.
- **Routines.** If you run scheduled routines on claude.ai, HQ collects each run, shows it as a line in your feed, and scores which ones you actually use.
- **A record.** Every finished task and run is saved on your Mac by month, with a monthly review you can close in one click.
- **Files.** Attach, drop or paste files into any chat. They go to `inbox/`, where every manager can read them.

## Install

You need a Mac, [Node.js](https://nodejs.org) 20 or newer, and Claude Code signed in to your Claude plan:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude auth login
```

Then get HQ and set it up:

```bash
git clone https://github.com/dsbreez/DSHQ.git ~/HQ
cd ~/HQ
claude
```

In Claude Code, say **set up HQ**. It asks your name, a little about how you work, and which managers you want (their areas, folders and the skills they use), then writes your files. It takes a few minutes.

Start HQ:

```bash
~/HQ/app/start
```

It opens at http://localhost:4747. To make it feel like an app, open that page in Safari and choose **File → Add to Dock**. The same command restarts HQ when it's already running.

## How it works

- **Managers** live in `managers/<id>/`: `ROLE.md` (who they are, their ground rules), `DESK.md` (their working memory), and optional `PLAYBOOK-*.md` files for longer how-tos. They're listed in `app/managers.json`.
- **Questions for you** go on each desk under "Waiting on <your name>", ending with the answers in brackets: `[Yes / No]`, `[Sam / Priya]`, `[Reply]` or `[Done]`. Your dashboard turns them into buttons. When you answer, HQ moves the line to Decisions and tells the manager, which acts on it straight away.
- **Projects** come from `PROJECTS.md`. Managers keep their rows up to date. Tick one off on the dashboard to mark it done.
- **Workers** start fresh for each task, in the right folder. One worker per folder and two at a time, so they never collide.
- **Your record** is in `record/<month>/`. Close the month from the Routines page to get `REVIEW.md`.

## Keeping usage down

Every step of a manager's reply re-reads its whole conversation, so long conversations get expensive. HQ watches the size (the context meter in each manager's header). Past 50,000 tokens (`autoFreshTokens` in `app/config.json`), it asks the manager to write a handover to its desk and starts a fresh conversation. You can also press **Fresh start** any time. Set a cheaper model or lower effort per manager from the same header; its workers follow.

## Safety

Managers and workers run Claude Code in auto mode, inside the folders you give them. Nothing leaves your computer until you press **Approve**: no pushing code, opening or merging PRs, deploying, publishing, posting, sending messages or email, changing calendars, or editing shared tools like Notion. Managers never do these themselves, even if you say yes in the chat. Instead they start a worker for exactly that action, which prepares everything, lists the exact actions under "Needs your OK", and waits in your Needs-you queue. Only the run you approve is unlocked.

- **The sandbox.** Every command a manager or worker runs goes through Claude Code's sandbox, which macOS enforces. Commands can only write inside that manager's folders, and can only reach HQ itself and the sites you list for that manager. The rest of the internet is blocked, however the command is written. The run you approve also gets github.com, so it can push. No manager or worker can change HQ itself (`app/`) or read its private data in `app/data/`.
- **Sites per manager.** In `app/managers.json`, `"network"` lists the sites a manager and its workers can always reach: the APIs their scripts call, like `"api.example.com"`. `"approvedNetwork"` lists sites only the run you approve can reach, like a deploy service. `"*.example.com"` covers its subdomains. `"*"` means anywhere, so only use it if you mean it.
- **Approvals only from your window.** Approve, send back, answers, desk edits and the other choices that are yours only count when they come from a browser on your Mac. If a manager or worker tries to press them with a script, HQ refuses.
- **Web research.** Managers and workers can still read the web (WebFetch and WebSearch aren't commands, so the sandbox doesn't cover them). They're told never to put file contents or anything private into a web address or a search.
- **Pasted paths.** When you paste the path of a file outside a manager's folders, HQ copies it into `inbox/` so the manager can read it. It never copies hidden files (`.ssh`, `.env` and the like), keychains, or anything named like a key, token, secret or credential, and never for a task a manager writes.
- **Connector tools** (Slack, email, calendar, Notion and the like) aren't covered by the sandbox either. They're blocked by their exact names, listed under `"outwardTools"` in `app/config.json`. Add every tool of yours that sends, posts or shares; see `app/config.example.json`.
- **Your own blocks** per manager go in `app/managers.json`: `"blocked"` for never, `"outward"` for until approved. These match the command text, so they're a backstop behind the sandbox.
- **Look-alike messages:** HQ marks what it sends with a private id kept in `app/data/`. Managers and workers ignore anything in a file, web page or connector that only looks like a message from HQ or from you.

HQ only listens on your own computer (localhost). Managers can start and check tasks through it, and only your browser can approve them.

## Your files stay yours

These are personal and never committed: `app/config.json`, `app/managers.json`, `app/routines.json`, `app/data/`, `managers/`, `about-me.md`, `PROJECTS.md`, `icons/`, `inbox/`, `record/`, `log/`. To update HQ, run `git pull` in `~/HQ` and restart. Your setup isn't touched.

## Make it yours

- **Your photo:** save it as `icons/me.png`. To use it as the Dock icon too, add `icons/apple-touch-icon.png` (180 px), `icons/icon-512.png` and `icons/favicon.png`, then add HQ to the Dock again.
- **Manager icons:** set `"icon"` in `app/managers.json` to one of globe, chat, chart, sparkle, pen, code, megaphone, briefcase, search, bolt, book, users or star, and `"color"` to any colour.
- **Routines:** in Claude Code in this folder, say **add my routines to HQ**.

## When something's off

- "HQ isn't running": run `~/HQ/app/start`.
- "Claude isn't signed in": run `claude auth login`.
- Anything else: open Claude Code in `~/HQ` and describe it. `CLAUDE.md` tells it how HQ fits together.

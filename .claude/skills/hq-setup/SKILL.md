---
name: hq-setup
description: Set up HQ for the person using this folder, or change their setup. Use when they say "set up HQ", "add a manager", "change my managers", "add my routines to HQ", "set my photo", or open this folder for the first time and app/managers.json doesn't exist.
---

# Setting up HQ

You're setting up HQ, a local dashboard of AI managers, for the person in front of you. They may not be technical. Ask a few short questions, make sensible calls for everything else, and write their files. Keep the whole thing to a few minutes.

All the files you write are personal and git-ignored. Never put passwords, API keys or tokens in any of them.

## 1. Check the basics

Run these and fix what's missing before going on:

- `node --version` must be 20 or newer. If not, point them to https://nodejs.org.
- `claude auth status` must show they're logged in. If Claude Code isn't installed, they run `curl -fsSL https://claude.ai/install.sh | bash`. If they're not logged in, they run `claude auth login` themselves.

## 2. About them

Ask, in one message:
1. Their first name, as they want HQ to greet them.
2. Their role and what they're responsible for.
3. How they like answers: short or detailed, technical or plain.

Write `app/config.json`:

```json
{ "name": "Alex", "aboutMe": "about-me.md", "autoFreshTokens": 50000, "outwardTools": [] }
```

Fill `outwardTools` from the connector tools you have in this session (names starting `mcp__`): every tool that sends, posts, schedules, shares, or creates or edits something other people see (Slack messages, email, calendar events, Notion pages and the like), by its full name. Leave read-only tools off. HQ blocks these for managers, and for workers until the person approves.

Write `about-me.md` from `about-me.example.md`, filled with their answers. Keep it under 20 lines.

## 3. Their managers

Ask which areas of their work they want a manager for. Two to four is a good start; more can come later. Offer examples like web, content, social, growth, research, ops or engineering. For each manager, ask:

- What it owns, in a sentence.
- The folder (or folders) on their computer where that work lives. Check each one exists. If they have none, create `~/<area>`.
- Any skills or tools it should use. Run `ls ~/.claude/skills` and list what's there so they can pick.

Then write, for each manager:

- An entry in `app/managers.json`, in the shape of `app/managers.example.json`:
  - `id`: short, lowercase, no spaces, e.g. `content`.
  - `name`: e.g. "Content Manager". `blurb`: one short line.
  - `icon`: one of globe, chat, chart, sparkle, pen, code, megaphone, briefcase, search, bolt, book, users, star. `color`: a hex colour; each manager gets a different one.
  - `home`: the main folder. `folders`: the main folder first, then any others.
  - `starters`: three things they'd plausibly ask it first.
  - Optional `network`: the sites this manager's commands may reach, as bare domains like `"api.example.com"` or `"*.example.com"`. Every command runs in Claude Code's sandbox, which blocks everything else. Check the scripts in its folders for the APIs they call (`grep -rhoE "https?://[a-zA-Z0-9.-]+" <folder>`, skipping data files) and list the ones it needs to read data or prepare work. Leave it out if the manager only works on files.
  - Optional `approvedNetwork`: sites only an approved run may reach, for the action itself, such as a deploy service. github.com is always included for approved runs. `"*"` means anywhere; only use it if they ask.
  - Optional `blocked`: tool rules the manager may never use, e.g. `"Bash(gh pr create *)"`. Optional `outward`: extra rules blocked until they approve. These match the command text, so they're a backstop behind the sandbox.
- `managers/<id>/ROLE.md`, modelled on `examples/managers/*/ROLE.md`: Owns, Home folder, Also uses, Skills, then Ground rules. Under 30 lines.
- `managers/<id>/DESK.md`, modelled on `examples/managers/*/DESK.md`, with the sections in this order: Working on, Next, Waiting on <their name>, Waiting on others, Decisions, Parked, Notes. Put one or two real first steps under Next. The heading must say "Waiting on" followed by exactly the name in `config.json`.

## 4. Projects (optional)

Ask whether they want their projects on the dashboard. If yes, ask for their current projects and write `PROJECTS.md` in the format of `PROJECTS.example.md`: numbered rows grouped by area, with a status emoji (🟢 moving, 🟡 waiting, ⏸ parked, ✅ done, 💤 dormant, ❓ unclear) and a one-line "Open / next".

## 5. Routines (optional)

If they run scheduled routines on claude.ai, use the RemoteTrigger tool with action `list` to find them. Read only: never create, change or run a routine here. The listing can be large; if it's saved to a file, read the id, name, enabled and cron_expression fields from it with a short script. For each enabled routine with a cron expression, add `{ "id": "<trigger id>", "name": "<short name>", "cron": "<cron_expression>", "where": "cloud" }` to `app/routines.json`. Cloud cron times are in UTC. Scheduled tasks that run on their own Mac can be listed with `"where": "mac"`. HQ shows those on the schedule but can't collect their results.

Without routines, write `[]` to `app/routines.json`.

## 6. Their photo (optional)

If they want their photo in HQ, save it as `icons/me.png`. To use it as the Dock icon too, make square copies with sips: `icons/apple-touch-icon.png` (180 px), `icons/icon-512.png` (512 px) and `icons/favicon.png` (64 px).

## 7. Start it

Tell them to run `~/HQ/app/start` (or `app/start` from this folder). It opens http://localhost:4747. In Safari, **File → Add to Dock** makes it an app. Approvals only count from that window (a browser on their Mac), never from a script. Point them to the README for how calls, workers and approvals work.

If HQ was already running, the same command restarts it so the new setup loads.

## Changing a setup later

To add a manager, do step 3 for just that one and restart HQ. To retire one, remove its entry from `app/managers.json`; leave its folder in `managers/` so its desk isn't lost.

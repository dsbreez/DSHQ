# HQ

A local app on top of Claude Code: managers (one ongoing conversation each, plus a desk file), background workers, a dashboard, routines and a monthly record. The person using this folder is not necessarily a developer: make technical calls yourself and explain outcomes in plain English.

## Layout

- `app/server.js`: the server (Node, no dependencies). It runs Claude Code headless for managers and workers. `app/lib/`: prompts, dashboard, routines, record, cron, the Claude runner. `app/public/`: the screen (vanilla JS, no build step). `app/bin/hq-task`: how managers start workers.
- Personal, never committed: `app/config.json` (name, profile path), `app/managers.json`, `app/routines.json`, `app/data/` (state and chats), `managers/<id>/` (ROLE.md, DESK.md, PLAYBOOK-*.md), `about-me.md`, `PROJECTS.md`, `icons/`, `inbox/`, `record/`, `log/`.
- Shared templates: `*.example.*` files, `examples/managers/`.

## Running

`app/start` starts HQ on http://localhost:4747, or restarts it if it's running. Changes to `app/public/` show on a page refresh. Changes to `app/server.js` or `app/lib/` need a restart, which interrupts running managers and workers, so check the "Now" section is empty first.

## Setting up

To set up HQ for someone, or add a manager, follow `.claude/skills/hq-setup/SKILL.md`.

## Rules

- Never put secrets, tokens or passwords in any of these files.
- Keep desks short: pointers, not essays. Keep ROLE.md under about 30 lines; longer material goes in a playbook.
- Desk questions for the owner end with their answers in brackets, e.g. `[Yes / No]`, so the dashboard can show buttons.

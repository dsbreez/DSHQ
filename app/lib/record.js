// The record: everything HQ has seen, kept on this Mac by month in ~/HQ/record/YYYY-MM/.
//   feed.jsonl   one line per event (tasks, managers)
//   runs.json    every scheduled run, with your verdicts
//   tasks.json   an index of finished tasks, plus tasks/<id>-<slug>.md with brief and report
//   REVIEW.md    written when you close the month
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const pad = n => String(n).padStart(2, '0');
export const monthKey = (ts = Date.now()) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
export const prevMonth = key => { const [y, m] = key.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`; };
export const monthLabel = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' }); };
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'task';
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const stamp = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export class Record {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
    this.runs = new Map();
    this.feed = [];
    this.saveTimers = {};
    const now = monthKey();
    for (const key of [prevMonth(now), now]) {
      for (const run of readJson(path.join(root, key, 'runs.json'), [])) this.runs.set(run.session_id, run);
      try {
        for (const line of fs.readFileSync(path.join(root, key, 'feed.jsonl'), 'utf8').split('\n')) {
          if (line.trim()) this.feed.push(JSON.parse(line));
        }
      } catch {}
    }
    this.trimFeed();
  }

  dir(key) {
    const dir = path.join(this.root, key);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  trimFeed() {
    const cutoff = Date.now() - 8 * 864e5;
    this.feed = this.feed.filter(e => e.at >= cutoff);
  }

  addEvent(event) {
    const entry = { id: crypto.randomUUID(), at: Date.now(), ...event };
    this.feed.push(entry);
    fs.appendFileSync(path.join(this.dir(monthKey(entry.at)), 'feed.jsonl'), `${JSON.stringify(entry)}\n`);
    return entry;
  }

  recentFeed(days = 7) {
    const cutoff = Date.now() - days * 864e5;
    return this.feed.filter(e => e.at >= cutoff);
  }

  // ----- scheduled runs -----

  upsertRun(run) {
    const merged = { ...(this.runs.get(run.session_id) || {}), ...run };
    this.runs.set(run.session_id, merged);
    this.saveRuns(monthKey(Date.parse(merged.created_at)));
    return merged;
  }

  run(id) { return this.runs.get(id); }

  monthRuns(key) {
    return [...this.runs.values()].filter(r => monthKey(Date.parse(r.created_at)) === key);
  }

  saveRuns(key) {
    clearTimeout(this.saveTimers[key]);
    this.saveTimers[key] = setTimeout(() => {
      const file = path.join(this.dir(key), 'runs.json');
      const runs = this.monthRuns(key).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(runs, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    }, 200);
  }

  // ----- finished tasks -----

  writeTask(task, managerName, owner = 'you') {
    const key = monthKey(task.doneAt || task.updatedAt);
    const dir = this.dir(key);
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
    const file = path.join(dir, 'tasks', `${task.id}-${slug(task.title)}.md`);
    const outcome = task.status === 'done' ? 'Done' : 'Discarded';
    fs.writeFileSync(file, [
      `# #${task.id} ${task.title}`, '',
      `- Manager: ${managerName}`,
      `- Folder: ${task.folder}`,
      `- Started: ${stamp(task.createdAt)} by ${task.from === 'manager' ? managerName : owner}`,
      `- Finished: ${stamp(task.doneAt || task.updatedAt)} (${outcome}, ${task.runs} round${task.runs === 1 ? '' : 's'})`,
      '', '## Brief', '', task.brief, '', '## Report', '', task.report || '_No report._', '',
    ].join('\n'));
    const indexFile = path.join(dir, 'tasks.json');
    const index = readJson(indexFile, []).filter(t => t.id !== task.id);
    index.push({ id: task.id, title: task.title, manager: task.manager, outcome, finishedAt: task.doneAt || task.updatedAt, file: path.relative(dir, file) });
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  }

  monthTasks(key) { return readJson(path.join(this.root, key, 'tasks.json'), []); }

  // ----- months -----

  reviewPath(key) { return path.join(this.root, key, 'REVIEW.md'); }
  isClosed(key) { return fs.existsSync(this.reviewPath(key)); }
  closedMonths() {
    try { return fs.readdirSync(this.root).filter(k => /^\d{4}-\d{2}$/.test(k) && this.isClosed(k)).sort().reverse(); } catch { return []; }
  }

  writeReview(key, { managers, scorecard, desks }) {
    const tasks = this.monthTasks(key);
    const lines = [`# ${monthLabel(key)} review`, '', `Written by HQ on ${stamp(Date.now())}. Everything behind it is in this folder.`, ''];
    lines.push('## What got done', '');
    for (const m of managers) {
      const done = tasks.filter(t => t.manager === m.id && t.outcome === 'Done');
      lines.push(`**${m.name}**: ${done.length ? `${done.length} task${done.length === 1 ? '' : 's'}` : 'no worker tasks'}`);
      for (const t of done) lines.push(`- #${t.id} ${t.title}`);
      lines.push('');
    }
    const discarded = tasks.filter(t => t.outcome === 'Discarded');
    if (discarded.length) lines.push(`Discarded: ${discarded.map(t => `#${t.id} ${t.title}`).join(', ')}`, '');

    lines.push('## Routines', '', '| Routine | Runs | Opened | Replied | Useful | Noise | Suggestion |', '|---|---|---|---|---|---|---|');
    for (const r of scorecard) {
      lines.push(`| ${r.name} | ${r.tracked ? r.runs : 'not tracked'} | ${r.opened} | ${r.replied} | ${r.useful} | ${r.noise} | ${r.hint} |`);
    }
    lines.push('', 'Opened means you opened the run in HQ. Replied means you answered it in Claude after it ran.', '');

    lines.push('## Desks at month end', '');
    for (const d of desks) lines.push(`- ${d.name}: ${d.summary}`);
    lines.push('', '## Your call', '', '- Which routines to keep, merge or pause', '- What, if anything, to move to Notion', '- Anything parked on a desk for over a month: keep or drop', '');
    this.dir(key);
    fs.writeFileSync(this.reviewPath(key), lines.join('\n'));
    return this.reviewPath(key);
  }
}

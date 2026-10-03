// Week updates: finished work filed for the owner's weekly update, one file per ISO week (Monday start, local time)
// in record/updates/, e.g. 2026-W40.jsonl. Managers add entries only when the owner asks; the owner edits them in HQ.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const pad = n => String(n).padStart(2, '0');
const DAY = 864e5;
export const WEEK = /^\d{4}-W\d{2}$/;
export const ENTRY_ID = /^\d{4}-W\d{2}-[0-9a-f]{8}$/;

// The ISO week a moment falls in: the week belongs to the year its Thursday is in.
export function weekKey(ts = Date.now()) {
  const d = new Date(ts);
  const thu = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7) + 3);
  return `${thu.getFullYear()}-W${pad(Math.floor(Math.round((thu - weekOneMonday(thu.getFullYear())) / DAY) / 7) + 1)}`;
}
function weekOneMonday(year) {
  const jan4 = new Date(year, 0, 4); // always in week 1
  return new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7));
}
// Midnight on the Monday that starts a week.
export function weekStart(key) {
  const [y, w] = key.split('-W').map(Number);
  const mon = weekOneMonday(y); // can be late December of the year before
  return new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + (w - 1) * 7).getTime();
}
export const prevWeek = key => weekKey(weekStart(key) - 3 * DAY);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function weekLabel(key) {
  const mon = new Date(weekStart(key));
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  const day = d => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${day(mon)} – ${day(sun)} ${sun.getFullYear()}`;
}

// An agent writes the summary with any links on their own lines: split them out.
export function splitLinks(text) {
  const links = [];
  const rest = [];
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim().replace(/^[-*]\s+/, '');
    if (/^https:\/\/\S+$/.test(t) || /^(~|\/Users)\/\S.*$/.test(t)) links.push(t);
    else rest.push(line);
  }
  return { summary: rest.join('\n').trim(), links };
}

// Title, summary (up to three lines) and links (https addresses or files in the home folder). Throws what's wrong.
export function cleanUpdate({ title, summary, links }, { home, clean = s => s, privatePath = () => false }) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  title = clean(String(title ?? '')).replace(/\s+/g, ' ').trim();
  summary = clean(String(summary ?? '')).split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  if (!title) fail('Give the update a title: the outcome, in a few words.');
  if (title.length > 120) fail('Keep the title under 120 characters.');
  if (summary.split('\n').length > 3 || summary.length > 600) fail('Keep the summary to three short lines: the outcome first, then at most two lines of detail.');
  const list = (Array.isArray(links) ? links : String(links ?? '').split('\n')).map(l => clean(String(l)).trim()).filter(Boolean);
  if (list.length > 6) fail('Six links at most.');
  const out = list.map(l => {
    if (/^https:\/\//i.test(l)) {
      try { if (new URL(l).protocol === 'https:' && l.length <= 500) return l; } catch {}
      fail(`That link doesn't look right: ${l.slice(0, 80)}`);
    }
    const abs = path.resolve(l.replace(/^~(?=\/|$)/, home));
    if (!/^(~|\/)/.test(l) || privatePath(abs, home)) fail(`Links are https addresses or files in the home folder: ${l.slice(0, 80)}`);
    return abs.startsWith(home) ? `~${abs.slice(home.length)}` : abs;
  });
  return { title, summary, links: [...new Set(out)] };
}

// The week as text ready to paste: grouped by manager in sidebar order, oldest first, https links only. No model involved.
export function asMarkdown(entries, managers, key) {
  if (!entries.length) return `Nothing filed for the week of ${weekLabel(key)}.\n`;
  const rank = id => { const i = managers.findIndex(m => m.id === id); return i < 0 ? 1e9 : i; };
  const lines = [`**Week of ${weekLabel(key)}**`, ''];
  for (const id of [...new Set(entries.map(e => e.manager))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    lines.push(`**${managers.find(m => m.id === id)?.name || id}**`);
    for (const e of entries.filter(x => x.manager === id).sort((a, b) => a.at - b.at)) {
      const [first, ...more] = e.summary ? e.summary.split('\n') : [];
      lines.push(`- ${e.title}${first ? `: ${first}` : ''}`);
      for (const line of more) lines.push(`  ${line}`);
      for (const link of e.links.filter(l => l.startsWith('https://'))) lines.push(`  ${link}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

export class Updates {
  constructor(dir) { this.dir = dir; }

  file(key) { return path.join(this.dir, `${key}.jsonl`); }

  // Newest first.
  week(key) {
    if (!WEEK.test(key)) return [];
    let text = '';
    try { text = fs.readFileSync(this.file(key), 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }).sort((a, b) => b.at - a.at);
  }

  add(fields) {
    const at = Date.now();
    const week = weekKey(at);
    const entry = { id: `${week}-${crypto.randomBytes(4).toString('hex')}`, at, ...fields };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file(week), `${JSON.stringify(entry)}\n`);
    return { ...entry, week };
  }

  // Edits and deletes rewrite the week's file: write a copy, then swap it in.
  rewrite(id, change) {
    if (!ENTRY_ID.test(String(id))) return null;
    const key = id.slice(0, 8);
    const entries = this.week(key).sort((a, b) => a.at - b.at);
    const i = entries.findIndex(e => e.id === id);
    if (i < 0) return null;
    const result = change(entries, i);
    const tmp = `${this.file(key)}.tmp`;
    fs.writeFileSync(tmp, entries.map(e => `${JSON.stringify(e)}\n`).join(''));
    fs.renameSync(tmp, this.file(key));
    return result;
  }

  edit(id, fields) { return this.rewrite(id, (list, i) => (list[i] = { ...list[i], ...fields, editedAt: Date.now() })); }
  remove(id) { return this.rewrite(id, (list, i) => list.splice(i, 1)[0]); }

  // The weeks that touch a month, with only that month's entries: for the monthly review.
  month(key) {
    const [y, m] = key.split('-').map(Number);
    const first = new Date(y, m - 1, 1).getTime();
    const end = new Date(y, m, 1).getTime();
    const out = [];
    for (let t = first; t < end; t += 7 * DAY) {
      const week = weekKey(t);
      if (out.some(w => w.week === week)) continue;
      const entries = this.week(week).filter(e => e.at >= first && e.at < end).sort((a, b) => a.at - b.at);
      if (entries.length) out.push({ week, label: weekLabel(week), entries });
    }
    const last = weekKey(end - 1);
    if (!out.some(w => w.week === last)) {
      const entries = this.week(last).filter(e => e.at >= first && e.at < end).sort((a, b) => a.at - b.at);
      if (entries.length) out.push({ week: last, label: weekLabel(last), entries });
    }
    return out;
  }
}

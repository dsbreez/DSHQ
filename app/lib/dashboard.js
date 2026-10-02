// The dashboard: questions you can answer in one tap, projects in one line each, and the day in a sentence.

// ----- calls: the "Waiting on <you>" lines on each desk -----

// Managers end a line with its answers in brackets: "[Yes / No]", "[Sam / Priya / Me]", "[Reply]" or "[Done]".
// Older lines without brackets get a best guess.
export function parseCall(raw) {
  let text = String(raw).trim();
  const tag = text.match(/\s*\[([^\]]+)\]\s*$/);
  if (tag) {
    text = text.slice(0, tag.index).trim();
    const options = tag[1].split('/').map(s => s.trim()).filter(Boolean).slice(0, 4);
    if (options.length === 1 && /^reply$/i.test(options[0])) return { raw, text, kind: 'reply', options: [] };
    if (options.length === 1 && /^done$/i.test(options[0])) return { raw, text, kind: 'done', options: [] };
    return { raw, text, kind: 'choice', options };
  }
  if (/\byes\s*(or|\/)\s*no\??\s*$/i.test(text)) {
    text = text.replace(/[\s,;:—-]*\byes\s*(or|\/)\s*no\??\s*$/i, '').trim();
    if (!/\?$/.test(text)) text += '?';
    return { raw, text, kind: 'choice', options: ['Yes', 'No'] };
  }
  if (/\byes\s*(\/|or)\s*no\b/i.test(text)) {
    text = text.replace(/\byes\s*(\/|or)\s*no\s*(on\s+)?/i, '').replace(/\s{2,}/g, ' ').trim().replace(/[.:]?$/, '?');
    return { raw, text, kind: 'choice', options: ['Yes', 'No'] };
  }
  const choice = text.match(/:\s*([^:?]+?)\?\s*$/);
  if (choice) {
    const options = choice[1].split(/,\s*|\s+or\s+/).map(s => s.trim()).filter(Boolean);
    if (options.length >= 2 && options.length <= 4 && options.every(o => o.split(/\s+/).length <= 3)) {
      return { raw, text: `${text.slice(0, choice.index).trim()}?`, kind: 'choice', options };
    }
  }
  // A closed question (anything with a "?" that isn't who/what/which/where/when/how) gets Yes and No.
  if (/\?/.test(text) && !/^(who|what|which|where|when|how|why)\b/i.test(text)) {
    return { raw, text, kind: 'choice', options: ['Yes', 'No'] };
  }
  return { raw, text, kind: 'reply', options: [] };
}

const sectionRe = name => new RegExp(`^##\\s+${name}\\s*$`, 'i');

// Move the answered line from the "Waiting on <you>" section to the top of "Decisions".
export function recordAnswer(desk, raw, answer, note, heading) {
  const lines = desk.split('\n');
  const start = lines.findIndex(l => sectionRe(heading).test(l));
  if (start < 0) return null;
  let index = -1;
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    if (lines[i].replace(/^[-*]\s+/, '').trim() === String(raw).trim()) { index = i; break; }
  }
  if (index < 0) return null;
  lines.splice(index, 1);
  const call = parseCall(raw);
  const date = new Date().toISOString().slice(0, 10);
  const decision = `- ${date}: ${call.text} → ${answer}${note ? ` (${note})` : ''}`;
  const decisions = lines.findIndex(l => sectionRe('Decisions').test(l));
  if (decisions >= 0) {
    let at = decisions + 1;
    while (at < lines.length && !lines[at].trim()) at++;
    if (at < lines.length && /^##\s/.test(lines[at])) lines.splice(decisions + 1, 0, '', decision);
    else lines.splice(at, 0, decision);
  } else {
    lines.push('', '## Decisions', decision);
  }
  return { desk: lines.join('\n'), call };
}

// ----- projects: ~/HQ/PROJECTS.md -----

const STATUS = { '🟢': 'moving', '🟡': 'waiting', '⏸': 'parked', '✅': 'done', '💤': 'dormant', '❓': 'unclear' };
const EMOJI = Object.fromEntries(Object.entries(STATUS).map(([e, s]) => [s, e]));

const cellsOf = line => line.split('|').slice(1, -1).map(c => c.trim());

export function parseProjects(text) {
  const out = [];
  let lane = '';
  for (const line of String(text).split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { lane = heading[1].replace(/\s*\(.*\)\s*$/, ''); continue; }
    const cells = cellsOf(line);
    if (cells.length < 4 || !/^\d+$/.test(cells[0])) continue;
    const [num, project, status, where, next = ''] = cells;
    const name = (project.match(/\*\*(.+?)\*\*/)?.[1] || project).replace(/\.$/, '').trim();
    const emoji = Object.keys(STATUS).find(e => status.startsWith(e));
    out.push({
      num: Number(num), name, about: project.replace(/\*\*.+?\*\*\s*/, '').trim(), status: STATUS[emoji] || 'unclear',
      statusNote: status.replace(emoji || '', '').trim(), lane, where, next: next.replace(/`/g, ''),
    });
  }
  return out;
}

export function setProjectStatus(text, num, status) {
  const emoji = EMOJI[status];
  if (!emoji) return null;
  let found = false;
  const lines = String(text).split('\n').map(line => {
    const cells = cellsOf(line);
    if (cells[0] !== String(num) || cells.length < 4) return line;
    found = true;
    cells[2] = emoji;
    return `| ${cells.join(' | ')} |`;
  });
  return found ? lines.join('\n') : null;
}

// ----- the day in a sentence -----

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const word = n => (n <= 10 ? WORDS[n] : String(n));
const lower = n => word(n).toLowerCase();
const short = name => name.replace(/ (Manager|Designer)$/, '').replace(/ Media$/, '');

export function daySummary({ managers, calls, tasks, upcoming }) {
  const review = tasks.filter(t => t.status === 'review');
  const trouble = tasks.filter(t => ['failed', 'interrupted', 'stopped'].includes(t.status));
  const working = tasks.filter(t => t.status === 'working');
  const total = calls.length + review.length + trouble.length;
  const sentences = [];
  if (!total) sentences.push(working.length ? 'Nothing needs you right now.' : 'Nothing needs you, and nothing is running.');
  else {
    const clauses = managers.map(m => {
      const c = calls.filter(x => x.manager === m.id).length;
      const r = review.filter(t => t.manager === m.id).length;
      const needs = [];
      if (c) needs.push(c === 1 ? 'one answer' : `${lower(c)} answers`);
      if (r) needs.push(r === 1 ? 'one review' : `${lower(r)} reviews`);
      return needs.length ? `${short(m.name)} needs ${needs.join(' and ')}` : null;
    }).filter(Boolean);
    sentences.push(`${word(total)} ${total === 1 ? 'thing needs' : 'things need'} you.`);
    if (clauses.length) sentences.push(`${clauses.length > 1 ? `${clauses.slice(0, -1).join(', ')}, and ${clauses.at(-1)}` : clauses[0]}.`);
    if (trouble.length) sentences.push(`${word(trouble.length)} task${trouble.length === 1 ? '' : 's'} hit a problem.`);
  }
  if (working.length) sentences.push(`${word(working.length)} worker${working.length === 1 ? ' is' : 's are'} on it.`);
  const next = upcoming[0];
  if (next) sentences.push(`Next up: ${next.routine} at ${new Date(next.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`);
  return sentences.join(' ');
}

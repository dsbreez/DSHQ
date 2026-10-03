// HQ: managers you talk to, workers that run in the background, scheduled routines,
// and a record of all of it on your computer.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runClaude, describeTool } from './lib/claude.js';
import { Store } from './lib/store.js';
import { Record, monthKey, prevMonth, monthLabel } from './lib/record.js';
import { Routines } from './lib/routines.js';
import { parseCall, recordAnswer, parseProjects, setProjectStatus, daySummary } from './lib/dashboard.js';
import { fromBrowser, privatePath } from './lib/safety.js';
import { teamFolders, teamRules, checkProposal, managerEntry, deskFor, appendManager } from './lib/team.js';
import { Updates, WEEK, weekKey, prevWeek, weekLabel, splitLinks, cleanUpdate, asMarkdown } from './lib/updates.js';
import * as P from './lib/prompts.js';

const APP = path.dirname(fileURLToPath(import.meta.url));
const HQ = path.dirname(APP);
const HOME = os.homedir();
const REAL_HOME = (() => { try { return fs.realpathSync(HOME); } catch { return HOME; } })();
const PORT = Number(process.env.HQ_PORT || 4747);
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const MAX_WORKERS = 2;
// Every step of a manager's reply re-reads the whole conversation. Past this size, HQ hands over to the
// desk and starts a fresh conversation after the reply, and Claude Code condenses anything that still grows.
let AUTO_FRESH_TOKENS = 50000;
const AUTOCOMPACT_TOKENS = 100000;
const MODELS = ['opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'max'];
const KEEP_DAYS = 7; // finished tasks stay on screen this long, then live only in the record

const expand = p => path.resolve(String(p).replace(/^~(?=\/|$)/, HOME));
const tilde = p => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
const hash = s => crypto.createHash('sha1').update(s).digest('hex');
const read = (file, fallback = '') => { try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; } };

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

// Who this HQ belongs to. config.json is personal and never shared; see config.example.json.
const CONFIG = { name: '', aboutMe: 'about-me.md', ...readJson(path.join(APP, 'config.json'), {}) };
const OWNER = CONFIG.name || 'the owner';
if (Number(CONFIG.autoFreshTokens) > 0) AUTO_FRESH_TOKENS = Number(CONFIG.autoFreshTokens);

// Network entries are bare domains (api.example.com, *.example.com, or * for anything). Claude Code can
// ignore settings it can't read without a word, sandbox and all, so HQ leaves out anything else.
const DOMAIN = /^(\*|(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d+)?)$/i;
const domains = (list, where) => (Array.isArray(list) ? list : []).filter(d => {
  if (DOMAIN.test(String(d))) return true;
  console.error(`managers.json: ignoring "${d}" in ${where}. Use a bare domain like api.example.com.`);
  return false;
});

// One manager from managers.json. A router ("router": true, like General) answers anything and routes the rest:
// it works across every manager's folders and carries every manager's blocks (see lib/team.js).
const toManager = m => ({
  ...m, router: m.router === true, homePath: expand(m.home), folderPaths: (m.folders || [m.home]).map(expand),
  network: domains(m.network, `${m.id}.network`), approvedNetwork: domains(m.approvedNetwork, `${m.id}.approvedNetwork`),
});
const MANAGERS = readJson(path.join(APP, 'managers.json'), []).map(toManager);
const byId = Object.fromEntries(MANAGERS.map(m => [m.id, m]));
// What a manager and its workers can reach, worked out live so a manager approved later counts at once.
const foldersOf = m => teamFolders(m, MANAGERS);
const folderList = m => (m.router ? foldersOf(m).map(tilde) : m.folders);
const blockedOf = m => teamRules(m, MANAGERS, 'blocked');
const outwardOf = m => teamRules(m, MANAGERS, 'outward');
const teamView = () => MANAGERS.map(m => ({ id: m.id, name: m.name, blurb: m.blurb, router: m.router, folders: m.folders }));

const store = new Store(path.join(APP, 'data'));
store.state.proposals ??= []; // new managers waiting for the owner's Approve
const record = new Record(path.join(HQ, 'record'));
const updates = new Updates(path.join(HQ, 'record', 'updates'));
const routines = new Routines({ appDir: APP, record, onChange: () => pushState() });
const managerDir = id => path.join(HQ, 'managers', id);
const deskPath = id => path.join(managerDir(id), 'DESK.md');
const rolePath = id => path.join(managerDir(id), 'ROLE.md');
const projectsPath = path.join(HQ, 'PROJECTS.md');
// HQ's private id: it marks what HQ itself sends, so managers and workers can tell it from look-alikes in files
// or web pages. Made once, kept in data/ (never shared), and kept off the screen and out of the record.
const SECRET_FILE = path.join(APP, 'data', 'secret.json');
let SECRET = readJson(SECRET_FILE, {}).id;
if (!/^[0-9a-f]{32}$/.test(SECRET || '')) {
  SECRET = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(SECRET_FILE, JSON.stringify({ id: SECRET }), { mode: 0o600 });
}
const hideId = text => String(text ?? '').split(SECRET).join('…');
P.configure({ owner: OWNER, projectsPath: tilde(projectsPath), secret: SECRET, updateFor: CONFIG.updateFor });
const WAITING = P.waitingHeading();
fs.mkdirSync(path.join(HQ, 'managers'), { recursive: true });
const INBOX = path.join(HQ, 'inbox');
const MAX_UPLOAD = 100 * 1024 * 1024;
const aboutOwner = () => read(path.join(HQ, CONFIG.aboutMe)).replace(/^# .*\n+/, '') || `No profile yet. ${OWNER} can add one in ${CONFIG.aboutMe}.`;

// Background-only tools that make no sense for a manager or worker.
const NEVER = ['CronCreate', 'CronDelete', 'ScheduleWakeup', 'RemoteTrigger', 'Workflow', 'PushNotification'];
// Anything that leaves the computer. Always blocked for managers, and for workers until you approve.
// Connector tools that send or share are listed in config.json ("outwardTools"); managers can add their own in managers.json ("outward").
const OUTWARD = [
  'Bash(git push *)', 'Bash(git push)', 'Bash(git -c *push*)',
  'Bash(gh pr create *)', 'Bash(gh pr merge *)', 'Bash(gh release *)',
  'Bash(vercel *)', 'Bash(npx vercel *)', 'Bash(npm publish *)',
  ...(CONFIG.outwardTools || []),
];

// The real gate for Bash: Claude Code's sandbox, enforced by macOS. Commands write only inside the run's
// folders and reach the network only through Claude Code's proxy, which lets through HQ itself (for hq-task)
// and the manager's own "network" domains. The run you approve also gets github.com and "approvedNetwork".
// The OUTWARD patterns above stay as a backstop. WebFetch, WebSearch and connectors aren't Bash: the
// prompts and the outwardTools names cover those.
// No run may change HQ itself (its code, managers.json, config) or read its data (the private id, chats):
// a change there would outlast the run, and widen every run after the next restart.
function sandbox(m, unlocked = false) {
  const allowed = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, ...m.network];
  if (unlocked) allowed.push('github.com', ...m.approvedNetwork);
  const data = path.join(APP, 'data');
  return {
    permissions: { deny: [`Edit(/${APP}/**)`, `Read(/${data}/**)`] },
    sandbox: {
      enabled: true,
      failIfUnavailable: true, // never fall back to running Bash unsandboxed
      allowUnsandboxedCommands: false, // and never let a command ask to skip it
      autoAllowBashIfSandboxed: true,
      filesystem: { denyWrite: [APP], denyRead: [data] },
      network: { allowedDomains: [...new Set(allowed)] },
    },
  };
}

// Files a review card may preview or open: deliverables inside the managers' folders and HQ.
const ASSET_ROOTS = [];
function addAssetRoots(list) {
  for (const r of list) {
    let real = r;
    try { real = fs.realpathSync(r); } catch {}
    if (!ASSET_ROOTS.includes(real)) ASSET_ROOTS.push(real);
  }
}
addAssetRoots([HQ, ...MANAGERS.flatMap(m => m.folderPaths)]);
const ASSET_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};
const assetKind = file => {
  const type = ASSET_TYPES[path.extname(file).toLowerCase()] || '';
  return type.startsWith('image/') ? 'image' : type === 'application/pdf' ? 'pdf' : type.startsWith('video/') ? 'video' : 'file';
};
function allowedAsset(target) {
  const abs = expand(target);
  if (!ASSET_TYPES[path.extname(abs).toLowerCase()] || !fs.existsSync(abs)) return null;
  const real = fs.realpathSync(abs);
  if (!fs.statSync(real).isFile()) return null; // a folder named like a file could be an app in disguise
  return ASSET_ROOTS.some(root => real === root || real.startsWith(`${root}${path.sep}`)) ? real : null;
}

// ---------- live updates to the browser ----------

const clients = new Set();
// A closed tab can leave a dead connection behind: drop it instead of writing to it.
function writeAll(msg) {
  for (const res of clients) {
    if (res.destroyed || res.socket?.destroyed) { clients.delete(res); continue; }
    try { res.write(msg); } catch { clients.delete(res); }
  }
}
function emit(type, data) {
  writeAll(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}
let stateTimer;
function pushState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => emit('state', snapshot()), 60);
}

function parseDesk(text) {
  const sections = {};
  let current = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { current = heading[1]; sections[current] = []; continue; }
    const item = line.match(/^[-*]\s+(.*)$/);
    if (current && item) sections[current].push(item[1]);
  }
  return sections;
}

const sessionFiles = {};
function conversationSize(sessionId) {
  if (!sessionId) return 0;
  if (!sessionFiles[sessionId]) {
    const root = path.join(HOME, '.claude', 'projects');
    try {
      const dir = fs.readdirSync(root).find(d => fs.existsSync(path.join(root, d, `${sessionId}.jsonl`)));
      if (dir) sessionFiles[sessionId] = path.join(root, dir, `${sessionId}.jsonl`);
    } catch {}
  }
  try { return fs.statSync(sessionFiles[sessionId]).size; } catch { return 0; }
}

const fmtTokens = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

function usageOf(result, steps) {
  const u = result?.usage || {};
  return {
    steps, cached: u.cache_read_input_tokens || 0, fresh: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    written: u.output_tokens || 0, cost: Number(result?.total_cost_usd) || 0,
  };
}

function logUsage(entry) {
  try { fs.appendFileSync(path.join(APP, 'data', 'usage.jsonl'), `${JSON.stringify({ at: Date.now(), ...entry })}\n`); } catch {}
}

const usageLine = u => `This reply: ${u.steps} step${u.steps === 1 ? '' : 's'}, ${fmtTokens(u.cached)} re-read from cache, ${fmtTokens(u.fresh)} new, ${fmtTokens(u.written)} written${u.cost ? ` · about $${u.cost.toFixed(2)} at API prices` : ''}`;

function oneLine(text, max = 140) {
  const line = String(text || '').split('\n').map(l => l.replace(/[#*_`>|]/g, '').replace(/^\s*[-\d.]+\s+/, '').trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : line;
}

// One line per thing that happened in the last week, newest first. Manager chatter collapses
// to its latest line per half hour so the feed stays readable.
function buildFeed() {
  const cutoff = Date.now() - 7 * 864e5;
  const events = record.recentFeed(7).map(e => ({ ...e }));
  for (const run of record.runs.values()) {
    const at = Date.parse(run.created_at);
    if (!(at >= cutoff)) continue;
    events.push({
      id: `run:${run.session_id}`, kind: 'run', at, routine: run.routine, runId: run.session_id,
      text: run.outcome || (run.ended_at ? 'Ran' : 'Running'), ok: run.ok, verdict: run.verdict || null,
    });
  }
  events.sort((a, b) => b.at - a.at);
  const lastKept = {};
  return events.filter(e => {
    if (e.kind !== 'manager') return true;
    if (lastKept[e.manager] && lastKept[e.manager] - e.at < 30 * 60000) return false;
    lastKept[e.manager] = e.at;
    return true;
  }).slice(0, 250);
}

function monthStatus() {
  const today = new Date().getDate();
  const current = monthKey();
  const previous = prevMonth(current);
  let closable = null;
  if (today >= 25 && !record.isClosed(current)) closable = current;
  else if (today <= 7 && !record.isClosed(previous) && fs.existsSync(path.join(HQ, 'record', previous))) closable = previous;
  return {
    current, label: monthLabel(current), closable, closableLabel: closable ? monthLabel(closable) : null,
    closed: record.closedMonths().map(key => ({ key, label: monthLabel(key) })),
  };
}

function calls() {
  return MANAGERS.flatMap(m => {
    const sections = parseDesk(read(deskPath(m.id)));
    return (sections[WAITING] || sections['Waiting on you'] || []).map(raw => ({ manager: m.id, ...parseCall(raw) }));
  });
}

function snapshot() {
  const tasks = store.state.tasks.filter(t => t.status !== 'discarded');
  const open = calls();
  const upcoming = routines.upcomingToday();
  return {
    version: 2,
    owner: { name: CONFIG.name, photo: fs.existsSync(path.join(HQ, 'icons', 'me.png')) },
    waitingHeading: WAITING,
    calls: open,
    projects: parseProjects(read(projectsPath)).filter(p => ['moving', 'waiting', 'unclear'].includes(p.status)),
    summary: daySummary({ managers: MANAGERS, calls: open, tasks, upcoming, proposals: store.state.proposals }),
    managers: MANAGERS.map(m => {
      const desk = read(deskPath(m.id));
      const l = live[m.id];
      const s = store.manager(m.id);
      return {
        id: m.id, name: m.name, blurb: m.blurb, hue: m.hue, icon: m.icon, color: m.color, home: m.home, folders: folderList(m), router: m.router, starters: m.starters || [],
        busy: l.busy, activity: l.activity, queued: l.queue.length, started: !!s.sessionId,
        model: s.model || '', effort: s.effort || '', connectors: s.connectors !== false,
        context: s.sessionId ? s.contextTokens || 0 : 0, autoFresh: AUTO_FRESH_TOKENS,
        long: (s.contextTokens || 0) > AUTO_FRESH_TOKENS * 0.75 || conversationSize(s.sessionId) > 3e6,
        desk: { text: desk, sections: parseDesk(desk) },
      };
    }),
    tasks,
    proposals: store.state.proposals,
    updates: weekUpdates(),
    feed: buildFeed(),
    upcoming,
    routines: { list: routines.scorecard(), ...routines.status() },
    month: monthStatus(),
  };
}

// ---------- managers: one ongoing conversation each ----------

const newLive = () => ({ busy: false, queue: [], run: null, activity: '', partial: '', stopped: false, fresh: false });
const live = Object.fromEntries(MANAGERS.map(m => [m.id, newLive()]));

const partialTimers = {};
function emitPartial(id) {
  if (partialTimers[id]) return;
  partialTimers[id] = setTimeout(() => {
    partialTimers[id] = null;
    emit('partial', { manager: id, text: hideId(live[id].partial), activity: live[id].activity, busy: live[id].busy });
  }, 50);
}

// extra: fields a role needs on screen, like a handoff's sender and title.
function pushChat(id, role, text, extra = {}) {
  const message = { id: crypto.randomUUID(), role, text: hideId(text), at: Date.now(), ...extra };
  store.chat(id).push(message);
  store.saveChat(id);
  emit('chat', { manager: id, message });
  return message;
}

function inboxFile(name) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(INBOX, day);
  fs.mkdirSync(dir, { recursive: true });
  const clean = path.basename(String(name || 'file')).replace(/[^\w.\- ()]+/g, '-').replace(/^\.+/, '').slice(0, 120) || 'file';
  const ext = path.extname(clean);
  let target = path.join(dir, clean);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${path.basename(clean, ext)}-${n}${ext}`);
  return target;
}

function receiveUpload(req, name) {
  return new Promise((resolve, reject) => {
    const target = inboxFile(name);
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', c => {
      if (failed) return;
      size += c.length;
      if (size > MAX_UPLOAD) { failed = true; reject(httpError(413, 'That file is over 100 MB. Share its path instead.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        fs.writeFileSync(target, Buffer.concat(chunks));
      } catch (err) {
        return reject(httpError(500, `Couldn't save that file in the inbox: ${err.message}`));
      }
      resolve({ path: tilde(target), name: path.basename(target), kind: assetKind(target), size });
    });
    req.on('error', err => { failed = true; reject(err); });
  });
}

// A path you paste in the chat may sit outside the folders a manager can read. Copy those into the inbox.
// Only for your own messages, never for a manager's task brief, and never keys, tokens or hidden files.
function bringFilesIn(text, readable) {
  const notes = [];
  const seen = new Set();
  for (const match of String(text).matchAll(/(?:~|\/Users\/)[^\n"'<>`]*?\.[A-Za-z0-9]{1,5}(?=[\s"'`),.;:]|$)/g)) {
    const shown = match[0];
    const abs = expand(shown);
    if (seen.has(abs) || !abs.startsWith(HOME)) continue;
    seen.add(abs);
    let stat, real;
    try { stat = fs.statSync(abs); real = fs.realpathSync(abs); } catch { continue; }
    if (privatePath(abs, HOME) || privatePath(real, REAL_HOME)) continue;
    if (!stat.isFile() || stat.size > MAX_UPLOAD) continue;
    if (readable.some(dir => abs === dir || abs.startsWith(`${dir}${path.sep}`))) continue;
    const copy = inboxFile(path.basename(abs));
    fs.copyFileSync(abs, copy);
    notes.push(`${shown} is copied to ${tilde(copy)} so you can read it.`);
  }
  return notes.length ? `${text}\n\n(${notes.join(' ')})` : text;
}

function sendToManager(id, text, display = text) {
  pushChat(id, 'you', display);
  live[id].queue.push(text);
  pumpManager(id);
}

function pumpManager(id, retried = false) {
  const l = live[id];
  if (l.busy || !l.queue.length) return;
  const m = byId[id];
  const s = store.manager(id);
  const text = l.queue.shift();
  const desk = read(deskPath(id));
  const role = read(rolePath(id));
  const fresh = !s.sessionId;
  const team = teamView();

  const context = [];
  if (s.updates.length) context.push(`Updates since your last message:\n${s.updates.map(u => `- ${u}`).join('\n')}`);
  if (!fresh && s.roleSeenHash && s.roleSeenHash !== hash(role)) context.push(`Your role file changed. It now reads:\n\n${role}`);
  const added = !fresh && (s.promptVersion || 1) < P.PROMPT_VERSION ? P.updatesSince(s.promptVersion || 1, { manager: m, team }) : '';
  if (added) context.push(`HQ has new instructions for you:\n\n${added}`);
  if (fresh || s.deskSeenHash !== hash(desk)) context.push(`Your desk right now:\n\n${desk}`);
  const prompt = context.length ? `<hq-context id="${SECRET}">\n${context.join('\n\n')}\n</hq-context>\n\n${text}` : text;
  const updatesSent = s.updates;
  s.updates = [];

  Object.assign(l, { busy: true, activity: 'Thinking', partial: '', stopped: false });
  let compacted = false;
  let wroteText = false;
  let lastText = '';
  let steps = 0;

  l.run = runClaude({
    cwd: m.homePath,
    prompt,
    sessionId: fresh ? crypto.randomUUID() : undefined,
    resume: fresh ? undefined : s.sessionId,
    name: `HQ · ${m.name}`,
    partial: true,
    model: s.model || undefined,
    effort: s.effort || undefined,
    autocompact: AUTOCOMPACT_TOKENS,
    connectors: s.connectors !== false,
    appendSystemPrompt: P.managerSystem({
      manager: m, role, deskPath: tilde(deskPath(id)), roleDir: tilde(managerDir(id)), folders: folderList(m), aboutOwner: aboutOwner(), team,
    }),
    addDirs: [HQ, ...foldersOf(m).filter(f => f !== m.homePath && fs.existsSync(f))],
    allowed: ['Bash(hq-task *)'],
    // Managers never act outward: they start a worker for it, and only the run you approve is unlocked.
    disallowed: [...NEVER, ...blockedOf(m), ...OUTWARD, ...outwardOf(m)],
    settings: sandbox(m),
    env: { HQ_MANAGER: id },
    onEvent: e => {
      if (e.type === 'system' && e.subtype === 'init') { s.sessionId = e.session_id; store.save(); return; }
      if (e.parent_tool_use_id) return;
      if (e.type === 'system' && e.subtype === 'compact_boundary') { compacted = true; return; }
      if (e.type === 'stream_event') {
        const ev = e.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          l.partial += ev.delta.text;
          l.activity = 'Writing';
          emitPartial(id);
        }
        return;
      }
      if (e.type === 'assistant') {
        const u = e.message?.usage;
        if (u) { steps++; s.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); }
        for (const block of e.message?.content || []) {
          if (block.type === 'text' && block.text.trim()) {
            l.partial = '';
            wroteText = true;
            lastText = hideId(block.text);
            pushChat(id, 'manager', lastText);
          } else if (block.type === 'tool_use') {
            l.partial = '';
            l.activity = hideId(describeTool(block.name, block.input));
            pushChat(id, 'activity', l.activity);
            emitPartial(id);
            pushState();
          }
        }
      }
    },
    onExit: ({ code, stderr, result, sawInit }) => {
      const { stopped, fresh: freshStart } = l;
      Object.assign(l, { run: null, busy: false, activity: '', partial: '', stopped: false, fresh: false });
      if (!sawInit && !fresh && !retried && /no conversation found/i.test(stderr)) {
        // The saved conversation is gone: start a new one and re-send.
        s.sessionId = null;
        s.updates = updatesSent.concat(s.updates);
        l.queue.unshift(text);
        if (freshStart) l.fresh = true;
        store.save();
        return pumpManager(id, true);
      }
      const ok = !stopped && result && !result.is_error;
      if (stopped) {
        pushChat(id, 'activity', 'Stopped');
      } else if (ok) {
        if (!wroteText && result.result) { lastText = hideId(result.result); pushChat(id, 'manager', lastText); }
        if (!freshStart && lastText) record.addEvent({ kind: 'manager', manager: id, text: oneLine(lastText) });
        const used = usageOf(result, steps);
        logUsage({ kind: 'manager', manager: id, ...used });
        pushChat(id, 'activity', usageLine(used));
      } else {
        s.updates = updatesSent.concat(s.updates);
        pushChat(id, 'error', friendlyError(result, stderr, code));
      }
      s.deskSeenHash = compacted ? null : hash(read(deskPath(id)));
      s.roleSeenHash = hash(read(rolePath(id)));
      if (ok) s.promptVersion = P.PROMPT_VERSION;
      if (freshStart && ok) startFresh(id, lastText);
      store.save();
      emitPartial(id);
      pushState();
      // A long conversation makes every message expensive: hand over to the desk and start fresh.
      if (ok && !freshStart && !l.queue.length && (s.contextTokens || 0) > AUTO_FRESH_TOKENS) {
        pushChat(id, 'activity', `This conversation reached ${Math.round(s.contextTokens / 1000)}k tokens. Writing a handover to the desk and starting fresh`);
        l.fresh = true;
        l.queue.push(P.handover());
      }
      pumpManager(id);
    },
  });
  pushState();
}

// Archive the long conversation, keep the handover note, and begin a new one from the desk.
function startFresh(id, handover) {
  const s = store.manager(id);
  const old = store.chat(id).slice();
  const dir = path.join(record.dir(monthKey()), 'chats');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`), JSON.stringify({ sessionId: s.sessionId, messages: old }, null, 2));
  Object.assign(s, { sessionId: null, deskSeenHash: null, roleSeenHash: null, contextTokens: 0 });
  const chat = store.chat(id);
  chat.length = 0;
  pushChat(id, 'divider', `Fresh start. The earlier conversation is saved in ~/HQ/record/${monthKey()}/chats.`);
  if (handover) pushChat(id, 'manager', handover);
  record.addEvent({ kind: 'manager', manager: id, text: 'Fresh start: handover written to the desk' });
  emit('reload-chat', { manager: id });
}

function freshStart(id) {
  const l = live[id];
  if (l.busy || l.queue.length) throw httpError(409, 'Wait until the current reply finishes.');
  if (!store.manager(id).sessionId) return;
  l.fresh = true;
  pushChat(id, 'activity', 'Fresh start: writing a handover to the desk');
  l.queue.push(P.handover());
  pumpManager(id);
}

function stopManager(id) {
  const l = live[id];
  l.queue = [];
  l.fresh = false;
  if (l.run) { l.stopped = true; l.run.kill(); }
  pushState();
}

function friendlyError(result, stderr, code) {
  const text = [result?.result, stderr].filter(Boolean).join('\n');
  if (/not logged in|please run \/login|invalid api key|authentication/i.test(text)) {
    return 'Claude isn\'t signed in on this Mac. In Terminal, run: claude auth login';
  }
  if (result?.result) return result.result;
  const last = stderr.split('\n').filter(Boolean).pop();
  return last || `Claude stopped unexpectedly (exit code ${code}).`;
}

// ---------- workers: background tasks ----------

const workers = new Map();

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function deriveTitle(brief) {
  const first = brief.split('\n').find(l => l.trim()) || 'Untitled task';
  const clean = first.replace(/[#*_`>]/g, '').trim();
  if (clean.length <= 64) return clean;
  return `${clean.slice(0, 64).replace(/\s+\S*$/, '')}…`;
}

function createTask({ manager, title, brief, folder, from }) {
  const m = byId[manager];
  if (!m) throw httpError(400, `There's no manager called "${manager}".`);
  brief = String(brief || '').trim();
  if (!brief) throw httpError(400, 'Describe the task first.');
  // A brief can't carry HQ's id: a worker never mistakes a manager's words for HQ's.
  // Files are only brought in for your own tasks: a manager can't use a brief to copy files out of their folder.
  if (from !== 'manager') brief = bringFilesIn(brief, [INBOX, managerDir(manager), ...foldersOf(m)]);
  brief = hideId(brief);
  const dir = folder ? expand(folder) : m.homePath;
  if (!dir.startsWith(HOME) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw httpError(400, `Folder not found: ${folder}`);
  }
  const task = {
    id: store.state.nextTaskId++, manager, title: String(title || '').trim() || deriveTitle(brief), brief,
    folder: tilde(dir), from: from === 'manager' ? 'manager' : 'owner', status: 'queued',
    createdAt: Date.now(), updatedAt: Date.now(), sessionId: null, activity: '', runs: 0,
    report: null, summary: '', needsOk: [], card: null, next: null,
  };
  store.state.tasks.push(task);
  store.log(task.id, { kind: 'system', text: `Created by ${task.from === 'manager' ? m.name : OWNER}` });
  record.addEvent({ kind: 'task', manager, taskId: task.id, text: `New task: ${task.title}` });
  if (task.from !== 'manager') managerUpdate(task, `${OWNER} started this task directly from the home screen.`);
  store.save();
  schedule();
  pushState();
  return task;
}

// One worker per folder, and at most MAX_WORKERS at once, so they never collide or eat the plan.
function schedule() {
  for (const task of store.state.tasks) {
    if (task.status !== 'queued') continue;
    const working = store.state.tasks.filter(t => t.status === 'working');
    if (working.length >= MAX_WORKERS) break;
    if (!working.some(t => t.folder === task.folder)) startWorker(task);
  }
}

function startWorker(task) {
  const m = byId[task.manager];
  const next = task.next;
  task.next = null;
  const fresh = !task.sessionId;
  const unlocked = next?.kind === 'approve';
  const prompt = fresh ? P.workerBrief({ task, desk: read(deskPath(m.id)) }) : P.fromHQ(next?.prompt || P.CARRY_ON);

  Object.assign(task, {
    status: 'working', activity: 'Starting', startedAt: Date.now(), updatedAt: Date.now(),
    runs: task.runs + 1, error: null, stopping: false,
  });
  store.log(task.id, {
    kind: 'system',
    text: fresh ? 'Worker started' : { approve: 'Approved: carrying out the actions', sendback: 'Sent back with a note' }[next?.kind] || 'Picked up again',
  });
  if (next?.note) store.log(task.id, { kind: 'note', text: next.note });

  let lastText = '';
  const folder = expand(task.folder);
  const run = runClaude({
    cwd: folder,
    prompt,
    sessionId: fresh ? crypto.randomUUID() : undefined,
    resume: fresh ? undefined : task.sessionId,
    name: `HQ #${task.id} · ${task.title}`,
    model: store.manager(m.id).model || undefined,
    effort: store.manager(m.id).effort || undefined,
    connectors: store.manager(m.id).connectors !== false,
    appendSystemPrompt: P.workerSystem({ manager: m, role: read(rolePath(m.id)), aboutOwner: aboutOwner() }),
    addDirs: [managerDir(m.id), ...(fs.existsSync(INBOX) ? [INBOX] : []), ...foldersOf(m).filter(f => f !== folder && fs.existsSync(f))],
    disallowed: [...NEVER, ...blockedOf(m), ...(unlocked ? [] : [...OUTWARD, ...outwardOf(m)])],
    settings: sandbox(m, unlocked),
    env: { HQ_MANAGER: m.id, HQ_TASK: String(task.id) },
    onEvent: e => {
      if (e.type === 'system' && e.subtype === 'init') { task.sessionId = e.session_id; store.save(); return; }
      if (e.parent_tool_use_id || e.type !== 'assistant') return;
      for (const block of e.message?.content || []) {
        if (block.type === 'tool_use') {
          task.activity = hideId(describeTool(block.name, block.input));
          task.updatedAt = Date.now();
          store.log(task.id, { kind: 'activity', text: task.activity });
          pushState();
        } else if (block.type === 'text' && block.text.trim()) {
          lastText = block.text;
        }
      }
    },
    onExit: ({ code, stderr, result }) => {
      workers.delete(task.id);
      Object.assign(task, { activity: '', finishedAt: Date.now(), updatedAt: Date.now() });
      if (result) {
        const used = usageOf(result, result.num_turns || 0);
        task.usage = { steps: (task.usage?.steps || 0) + used.steps, cached: (task.usage?.cached || 0) + used.cached, fresh: (task.usage?.fresh || 0) + used.fresh, written: (task.usage?.written || 0) + used.written, cost: (task.usage?.cost || 0) + used.cost };
        logUsage({ kind: 'worker', manager: m.id, task: task.id, ...used });
      }
      if (task.stopping) {
        task.stopping = false;
        task.status = 'stopped';
        store.log(task.id, { kind: 'system', text: `Stopped by ${OWNER}` });
      } else if (result && !result.is_error) {
        const report = hideId(result.result || lastText);
        Object.assign(task, { report, summary: summaryOf(report), needsOk: parseNeedsOk(report), card: parseCard(report) });
        store.log(task.id, { kind: 'report', text: report });
        if (unlocked && !task.needsOk.length) {
          finish(task);
          notify(m.name, `Done: ${task.title}`);
        } else {
          task.status = 'review';
          managerUpdate(task, `Finished, waiting for ${OWNER}'s review. ${task.summary}`);
          record.addEvent({ kind: 'task', manager: m.id, taskId: task.id, status: 'review', text: `Ready for you: ${task.title}` });
          notify(m.name, `Ready for you: ${task.title}`);
        }
      } else {
        task.status = 'failed';
        task.error = hideId(friendlyError(result, stderr, code));
        store.log(task.id, { kind: 'error', text: task.error });
        managerUpdate(task, `Failed: ${task.error.slice(0, 200)}`);
        record.addEvent({ kind: 'task', manager: m.id, taskId: task.id, status: 'failed', text: `Hit a problem: ${task.title}` });
        notify(m.name, `Hit a problem: ${task.title}`);
      }
      store.save();
      pushState();
      schedule();
    },
  });
  workers.set(task.id, run);
}

function reportSections(md) {
  const out = {};
  let current = '_';
  for (const line of String(md).split('\n')) {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*:?\s*$/);
    if (heading) { current = heading[1].replace(/\s*\(.*?\)\s*$/, '').toLowerCase(); out[current] = []; continue; }
    (out[current] ??= []).push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
}

function parseNeedsOk(report) {
  return (reportSections(report)['needs your ok'] || '')
    .split('\n')
    .map(l => l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/)?.[1])
    .filter(Boolean)
    .filter(t => !/^nothing\b/i.test(t.replace(/[*_]/g, '')));
}

function summaryOf(report) {
  const s = reportSections(report);
  return (s.summary || s._ || '').split(/\n\s*\n/)[0].replace(/[#*_`>]/g, '').trim().slice(0, 400);
}

// The short card you see first: copy to paste, the asset it needs, and why.
function parseCard(report) {
  const s = reportSections(report);
  const blocks = text => [...String(text).matchAll(/```post[^\n]*\n([\s\S]*?)```/g)].map(m => m[1].trim()).filter(Boolean);
  const posts = blocks(s.post || s.posts || '').length ? blocks(s.post || s.posts) : blocks(report);
  const assets = [];
  let needsMaking = '';
  for (const raw of (s.asset || s.assets || '').split('\n')) {
    const line = raw.replace(/^\s*[-*]\s+/, '').replace(/`/g, '').trim();
    if (!line) continue;
    const found = line.match(/(~\/\S+|\/\S+\.[A-Za-z0-9]{2,5}\b)/);
    if (found) {
      const file = found[1].replace(/[.,;:)]+$/, '');
      assets.push({ path: tilde(expand(file)), kind: assetKind(file), exists: !!allowedAsset(file) });
    } else if (/needs making/i.test(line) || !needsMaking) {
      needsMaking = line.replace(/^needs making:?\s*/i, '');
    }
  }
  const why = (s.why || '').split('\n').map(l => l.trim()).find(Boolean) || '';
  return { posts: posts.slice(0, 3), assets: assets.slice(0, 4), needsMaking, why };
}

function managerUpdate(task, text) {
  const s = store.manager(task.manager);
  s.updates.push(`Task #${task.id} "${task.title}": ${text}`);
  s.updates = s.updates.slice(-20);
}

function finish(task) {
  Object.assign(task, { status: 'done', doneAt: Date.now(), updatedAt: Date.now() });
  store.log(task.id, { kind: 'system', text: 'Marked done' });
  managerUpdate(task, 'Done.');
  logToHQ(task);
  record.writeTask(task, byId[task.manager]?.name || task.manager, OWNER);
  record.addEvent({ kind: 'task', manager: task.manager, taskId: task.id, status: 'done', text: `Done: ${task.title}` });
}

// One dated line in the month's HQ log, newest first, like /hq done.
function logToHQ(task) {
  try {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    fs.mkdirSync(path.join(HQ, 'log'), { recursive: true });
    const file = path.join(HQ, 'log', `${d.getFullYear()}-${pad(d.getMonth() + 1)}.md`);
    const lines = (read(file) || `# ${monthLabel(monthKey())}\n\nOne line per thing shipped.\n`).split('\n');
    const entry = `- ${pad(d.getMonth() + 1)}-${pad(d.getDate())} [${task.manager}] ${task.title} — ${task.folder}, HQ task #${task.id}`;
    const first = lines.findIndex(l => l.startsWith('- '));
    if (first >= 0) lines.splice(first, 0, entry);
    else { while (lines.length && !lines.at(-1).trim()) lines.pop(); lines.push('', entry, ''); }
    fs.writeFileSync(file, lines.join('\n'));
  } catch (err) { console.error('Could not write the HQ log', err); }
}

// Finished tasks leave the screen after a week. Their brief and report are already in the record.
function pruneTasks() {
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const before = store.state.tasks.length;
  store.state.tasks = store.state.tasks.filter(t => !((t.status === 'done' || t.status === 'discarded') && t.updatedAt < cutoff));
  if (store.state.tasks.length !== before) { store.save(); pushState(); }
}

function notify(subtitle, body) {
  const script = `display notification ${JSON.stringify(body)} with title "HQ" subtitle ${JSON.stringify(subtitle)}`;
  execFile('osascript', ['-e', script], () => {});
}

function taskAction(task, action, body) {
  const requeue = next => { task.next = next; task.status = 'queued'; task.updatedAt = Date.now(); };
  switch (action) {
    case 'approve': {
      // Approve as is, or approve with context: the worker gets the go-ahead and your note together.
      if (task.status !== 'review') throw httpError(409, 'This task isn\'t waiting for approval.');
      const note = String(body.note || '').trim();
      if (!task.needsOk.length && !note) { finish(task); break; }
      if (!task.sessionId) throw httpError(409, 'This task never started, so there is nothing to approve.');
      requeue({ kind: 'approve', prompt: P.approved(note), note });
      record.addEvent({ kind: 'task', manager: task.manager, taskId: task.id, text: `You approved${note ? ' with context' : ''}: ${task.title}` });
      if (note) managerUpdate(task, `${OWNER} approved with context: ${note.slice(0, 200)}`);
      break;
    }
    case 'send-back': {
      const note = String(body.note || '').trim();
      if (!note) throw httpError(400, 'Add a note so the worker knows what to change.');
      if (!task.sessionId) throw httpError(409, 'This task never started, so there is nothing to send back.');
      if (task.status === 'working') throw httpError(409, 'This task is still running.');
      requeue({ kind: 'sendback', prompt: P.sendBack(note), note });
      managerUpdate(task, `${OWNER} sent it back: ${note.slice(0, 200)}`);
      break;
    }
    case 'done':
      if (task.status === 'working') throw httpError(409, 'This task is still running. Stop it first.');
      finish(task);
      break;
    case 'retry':
      if (task.status === 'working') throw httpError(409, 'This task is already running.');
      requeue(task.sessionId ? { kind: 'resume', prompt: P.CARRY_ON } : null);
      break;
    case 'stop':
      if (task.status === 'working') { task.stopping = true; workers.get(task.id)?.kill(); }
      else if (task.status === 'queued') { task.status = 'stopped'; task.next = null; }
      break;
    case 'discard':
      if (task.status === 'working') throw httpError(409, 'This task is still running. Stop it first.');
      task.status = 'discarded';
      task.updatedAt = Date.now();
      managerUpdate(task, `${OWNER} discarded it.`);
      record.writeTask(task, byId[task.manager]?.name || task.manager, OWNER);
      record.addEvent({ kind: 'task', manager: task.manager, taskId: task.id, status: 'discarded', text: `Discarded: ${task.title}` });
      break;
    default:
      throw httpError(404, 'Unknown action');
  }
  store.save();
  schedule();
  pushState();
}

function answerCall({ manager, raw, answer, note }) {
  const m = byId[manager];
  if (!m) throw httpError(400, `There's no manager called "${manager}".`);
  answer = String(answer || '').trim();
  note = String(note || '').trim();
  if (!answer) throw httpError(400, 'Pick an answer or type a reply.');
  const result = recordAnswer(read(deskPath(manager)), raw, answer, note, WAITING);
  if (!result) throw httpError(409, 'That question has changed on the desk. Have another look.');
  fs.writeFileSync(deskPath(manager), result.desk);
  const question = result.call.text;
  record.addEvent({ kind: 'call', manager, text: `You answered: ${question} → ${answer}` });
  sendToManager(manager, P.answered({ question, answer, note }), `Answered from the dashboard: ${question} → ${answer}${note ? ` (${note})` : ''}`);
  pushState();
}

// ---------- the team: handoffs and new managers ----------

// Work passed from one manager to another. It shows in the target's chat as a handoff, and HQ sends it on marked as
// its own, with the brief framed as the sender's words. Agents may call this: nothing leaves the computer.
function handoff({ from, to, title, brief }) {
  const a = byId[from];
  const b = byId[to];
  const ids = MANAGERS.map(m => m.id).join(', ');
  if (!a) throw httpError(400, `Which manager is handing this over? Pass --from <your id>, one of ${ids}.`);
  if (!b) throw httpError(400, `There's no manager "${to}". Use --to with one of ${ids}.`);
  if (a === b) throw httpError(400, 'That\'s you. Hand it to another manager.');
  brief = hideId(String(brief || '').trim());
  if (!brief) throw httpError(400, 'Write the brief on stdin (a heredoc).');
  if (brief.length > 20000) throw httpError(413, 'Keep the brief under 20,000 characters. Point to files for the rest.');
  title = hideId(String(title || '').replace(/\s+/g, ' ').trim()) || deriveTitle(brief);
  if (title.length > 120) throw httpError(400, 'Keep the title under 120 characters.');
  pushChat(b.id, 'handoff', brief, { from: a.id, fromName: a.name, title });
  live[b.id].queue.push(P.handedOver({ from: a.name, title, brief }));
  record.addEvent({ kind: 'handoff', manager: b.id, from: a.id, text: `Handed over from ${a.name}: ${title}` });
  pumpManager(b.id);
  pushState();
  return { to: b.id, name: b.name, title };
}

const proposalContext = skip => ({
  managers: MANAGERS, proposals: store.state.proposals.filter(p => p !== skip), home: HOME, hq: HQ, app: APP, clean: hideId,
  taken: id => fs.existsSync(rolePath(id)) || fs.existsSync(deskPath(id)),
});

// A new manager, drafted by a manager (General) and checked here. It waits under To Review for the owner.
function propose(body) {
  const from = byId[body?.from];
  if (!from) throw httpError(400, `Which manager is proposing this? Pass "from", one of ${MANAGERS.map(m => m.id).join(', ')}.`);
  if (store.state.proposals.length >= 10) throw httpError(429, `Ten new managers are already waiting for ${OWNER}. Wait until some are approved or discarded.`);
  const proposal = { ...checkProposal(body, proposalContext()), from: from.id, at: Date.now() };
  store.state.proposals.push(proposal);
  record.addEvent({ kind: 'proposal', manager: from.id, text: `Proposed a new manager: ${proposal.name}` });
  notify(from.name, `New manager to approve: ${proposal.name}`);
  store.save();
  pushState();
  return proposal;
}

// A manager approved while HQ runs: everything that knows the team learns about it, no restart needed.
// New managers get no network and no blocks of their own; the owner adds those in managers.json.
function addManager(entry) {
  const m = toManager(entry);
  MANAGERS.push(m);
  byId[m.id] = m;
  live[m.id] = newLive();
  addAssetRoots(m.folderPaths);
  return m;
}

// Owner only. Checks the proposal again, then writes managers.json, ROLE.md and DESK.md and adds the manager live.
function approveProposal(id) {
  const proposal = store.state.proposals.find(p => p.id === id);
  if (!proposal) throw httpError(404, 'That proposal is gone. Have another look.');
  const p = checkProposal(proposal, proposalContext(proposal)); // folders or the team may have changed since
  const by = byId[proposal.from];
  fs.mkdirSync(expand(p.home), { recursive: true });
  const entry = managerEntry(p);
  appendManager(path.join(APP, 'managers.json'), entry);
  fs.mkdirSync(managerDir(p.id), { recursive: true });
  fs.writeFileSync(rolePath(p.id), `${p.role.trim()}\n`);
  fs.writeFileSync(deskPath(p.id), deskFor({
    name: p.name, waiting: WAITING, firstSteps: p.firstSteps,
    note: `Created ${new Date().toISOString().slice(0, 10)}${by ? ` from ${by.name}'s proposal` : ''}.`,
  }));
  addManager(entry);
  store.state.proposals = store.state.proposals.filter(x => x !== proposal);
  record.addEvent({ kind: 'system', manager: p.id, text: `New manager: ${p.name}` });
  store.save();
  pushState();
  if (by && p.handoff) handoff({ from: by.id, to: p.id, ...p.handoff });
  if (by) {
    pushChat(by.id, 'note', `${OWNER} approved ${p.name}. Created it${p.handoff && by ? ` and handed over "${p.handoff.title}"` : ''}.`);
    live[by.id].queue.push(P.managerCreated({ name: p.name, id: p.id, title: p.handoff?.title }));
    pumpManager(by.id);
  }
  return { id: p.id, name: p.name };
}

function discardProposal(id) {
  const proposal = store.state.proposals.find(p => p.id === id);
  if (!proposal) throw httpError(404, 'That proposal is gone. Have another look.');
  store.state.proposals = store.state.proposals.filter(x => x !== proposal);
  if (byId[proposal.from]) {
    const s = store.manager(proposal.from);
    s.updates.push(`${OWNER} discarded the new manager you proposed, ${proposal.name}.${proposal.handoff ? ` "${proposal.handoff.title}" wasn't handed over.` : ''}`);
    s.updates = s.updates.slice(-20);
  }
  record.addEvent({ kind: 'proposal', manager: proposal.from, text: `Discarded the proposed manager ${proposal.name}` });
  store.save();
  pushState();
}

// ---------- week updates ----------

const updateCtx = { home: HOME, clean: hideId, privatePath };

function weekView(key) {
  const entries = updates.week(key);
  return { key, label: weekLabel(key), path: tilde(updates.file(key)), entries, markdown: asMarkdown(entries, MANAGERS, key) };
}
const weekUpdates = () => ({ for: CONFIG.updateFor || '', weeks: [weekView(weekKey()), weekView(prevWeek(weekKey()))] });

// From a manager (hq-task update) or from the owner's window (Add to week updates on a task).
function fileUpdate(body) {
  const taskId = body.task ?? body.taskId;
  const hasTask = taskId != null && taskId !== '';
  const task = hasTask ? store.task(taskId) : null;
  if (hasTask && !task) throw httpError(400, `There's no task #${taskId}.`);
  const manager = byId[body.manager]?.id || task?.manager;
  if (!manager) throw httpError(400, 'Which manager is this from? Pass --manager <id>.');
  const fields = cleanUpdate(body.text != null ? { title: body.title, ...splitLinks(body.text) } : body, updateCtx);
  const entry = updates.add({ manager, ...fields, taskId: task?.id ?? null });
  record.addEvent({ kind: 'update', manager, text: `Added to week updates: ${entry.title}` });
  pushState();
  return entry;
}

function editUpdate(id, body) {
  const entry = updates.edit(id, cleanUpdate(body, updateCtx));
  if (!entry) throw httpError(404, 'That update is gone. Have another look.');
  pushState();
  return entry;
}

function deleteUpdate(id) {
  if (!updates.remove(id)) throw httpError(404, 'That update is gone. Have another look.');
  pushState();
}

function setProject(num, status) {
  const text = read(projectsPath);
  const updated = setProjectStatus(text, num, status);
  if (!updated) throw httpError(404, `No project #${num}, or that status isn't one HQ knows.`);
  fs.writeFileSync(projectsPath, updated);
  const project = parseProjects(updated).find(p => p.num === Number(num));
  record.addEvent({ kind: 'project', text: `${project?.name || `Project #${num}`}: ${status === 'done' ? 'done' : `marked ${status}`}` });
  pushState();
}

function closeMonth(key) {
  if (!/^\d{4}-\d{2}$/.test(key || '')) throw httpError(400, 'Which month?');
  const desks = MANAGERS.map(m => {
    const sec = parseDesk(read(deskPath(m.id)));
    const n = k => (sec[k] || []).length;
    return { name: m.name, summary: `${n('Working on')} working on, ${n(WAITING)} waiting on you, ${n('Next')} next, ${n('Parked')} parked` };
  });
  const file = record.writeReview(key, { managers: MANAGERS, scorecard: routines.scorecard(key), desks, updates: updates.month(key) });
  record.addEvent({ kind: 'system', text: `${monthLabel(key)} closed. Review written` });
  pushState();
  return { path: tilde(file), text: read(file) };
}

// ---------- HTTP ----------

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Choices only you make. They count only from your HQ window (a browser on this Mac), never from a script
// a manager or worker runs, even one that copies the page's headers.
function ownerOnly(method, area, id, action) {
  if (method === 'GET') return false;
  if (area === 'tasks') return !!(id && action); // approve, done, send-back, discard, retry, stop
  if (area === 'managers') return ['message', 'fresh', 'settings', 'desk'].includes(action);
  if (area === 'calls') return id === 'answer';
  if (area === 'projects') return action === 'status';
  if (area === 'review') return id === 'close';
  if (area === 'runs') return action === 'verdict';
  if (area === 'proposals') return !!(id && action); // approve or discard a new manager
  if (area === 'updates') return !!id; // edit or delete a week update; filing one is open to managers
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', c => { data += c; if (data.length > 2e6) reject(httpError(413, 'Too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(httpError(400, 'Bad JSON')); } });
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
const PERSONAL_ICONS = new Set(['me.png', 'apple-touch-icon.png', 'icon-512.png', 'favicon.png']);
function serveStatic(pathname, res) {
  const name = pathname.replace(/^\//, '');
  const personal = path.join(HQ, 'icons', name);
  if (PERSONAL_ICONS.has(name) && fs.existsSync(personal)) {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
    return fs.createReadStream(personal).pipe(res);
  }
  const root = path.join(APP, 'public');
  const file = path.normalize(path.join(root, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    // Only this Mac's browser and the hq-task script may talk to HQ.
    if (!HOSTS.has(req.headers.host)) return send(res, 403, { error: 'Forbidden' });
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: 'Forbidden' });
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (req.headers['x-hq'] !== '1' || (origin && !HOSTS.has(origin.replace(/^https?:\/\//, '')))) {
        return send(res, 403, { error: 'Forbidden' });
      }
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api') return serveStatic(url.pathname, res);
    const [, area, id, action] = parts;
    if (ownerOnly(req.method, area, id, action) && !(await fromBrowser(req, PORT))) {
      throw httpError(403, 'Approvals only count from your HQ window.');
    }

    if (area === 'state' && req.method === 'GET') return send(res, 200, snapshot());

    if (area === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // Agent-callable: hand work to another manager, or propose a new one. Neither leaves the computer.
    if (area === 'handoff' && !id && req.method === 'POST') return send(res, 200, handoff(await readBody(req)));
    if (area === 'managers' && id === 'propose' && !action && req.method === 'POST') return send(res, 200, propose(await readBody(req)));
    if (area === 'proposals' && id && req.method === 'POST') {
      if (action === 'approve') return send(res, 200, approveProposal(id));
      if (action === 'discard') { discardProposal(id); return send(res, 200, { ok: true }); }
    }

    if (area === 'updates') {
      if (!id && req.method === 'GET') {
        const week = url.searchParams.get('week') || weekKey();
        if (!WEEK.test(week)) throw httpError(400, 'A week looks like 2026-W40.');
        return send(res, 200, weekView(week));
      }
      if (!id && req.method === 'POST') return send(res, 200, fileUpdate(await readBody(req)));
      if (id && req.method === 'PUT') return send(res, 200, editUpdate(id, await readBody(req)));
      if (id && req.method === 'DELETE') { deleteUpdate(id); return send(res, 200, { ok: true }); }
    }

    if (area === 'managers' && byId[id]) {
      if (action === 'chat' && req.method === 'GET') {
        const l = live[id];
        return send(res, 200, { messages: store.chat(id).slice(-600), partial: hideId(l.partial), busy: l.busy, activity: l.activity });
      }
      if (action === 'message' && req.method === 'POST') {
        const { text } = await readBody(req);
        if (!String(text || '').trim()) throw httpError(400, 'Type a message first.');
        const m = byId[id];
        sendToManager(id, bringFilesIn(String(text).trim(), [HQ, ...foldersOf(m)]), String(text).trim());
        return send(res, 200, { ok: true });
      }
      if (action === 'stop' && req.method === 'POST') { stopManager(id); return send(res, 200, { ok: true }); }
      if (action === 'fresh' && req.method === 'POST') { freshStart(id); return send(res, 200, { ok: true }); }
      if (action === 'settings' && req.method === 'PUT') {
        const { model = '', effort = '', connectors = true } = await readBody(req);
        if (model && !MODELS.includes(model)) throw httpError(400, `Model is one of ${MODELS.join(', ')}, or empty for your plan's default.`);
        if (effort && !EFFORTS.includes(effort)) throw httpError(400, `Effort is one of ${EFFORTS.join(', ')}, or empty for the default.`);
        Object.assign(store.manager(id), { model, effort, connectors: connectors !== false });
        store.save();
        pushState();
        return send(res, 200, { ok: true });
      }
      if (action === 'desk' && req.method === 'GET') return send(res, 200, { text: read(deskPath(id)) });
      if (action === 'desk' && req.method === 'PUT') {
        const { text } = await readBody(req);
        fs.writeFileSync(deskPath(id), String(text ?? ''));
        pushState();
        return send(res, 200, { ok: true });
      }
    }

    if (area === 'tasks') {
      if (!id && req.method === 'GET') {
        const manager = url.searchParams.get('manager');
        return send(res, 200, store.state.tasks.filter(t => t.status !== 'discarded' && (!manager || t.manager === manager)));
      }
      if (!id && req.method === 'POST') {
        // A task is yours only when it comes from your HQ window. Anything else (hq-task) is a manager's.
        const body = await readBody(req);
        const from = body.from !== 'manager' && (await fromBrowser(req, PORT)) ? 'owner' : 'manager';
        return send(res, 200, createTask({ ...body, from }));
      }
      const task = store.task(id);
      if (!task) throw httpError(404, `No task #${id}`);
      if (!action && req.method === 'GET') return send(res, 200, { task, log: store.readLog(task.id) });
      if (action && req.method === 'POST') { taskAction(task, action, await readBody(req)); return send(res, 200, task); }
    }

    if (area === 'upload' && req.method === 'POST') {
      return send(res, 200, await receiveUpload(req, url.searchParams.get('name')));
    }

    if (area === 'calls' && id === 'answer' && req.method === 'POST') {
      answerCall(await readBody(req));
      return send(res, 200, { ok: true });
    }

    if (area === 'projects' && /^\d+$/.test(id || '') && action === 'status' && req.method === 'POST') {
      setProject(Number(id), (await readBody(req)).status);
      return send(res, 200, { ok: true });
    }

    if (area === 'routines' && id === 'sync' && req.method === 'POST') {
      routines.syncNow().catch(err => console.error('Routine check failed', err));
      return send(res, 200, { ok: true });
    }

    if (area === 'runs' && id) {
      const run = record.run(id);
      if (!run) throw httpError(404, 'That run isn\'t in the record.');
      if (action === 'opened' && req.method === 'POST') { record.upsertRun({ ...run, opened: true }); pushState(); return send(res, 200, { ok: true }); }
      if (action === 'verdict' && req.method === 'POST') {
        const { verdict } = await readBody(req);
        if (![null, 'useful', 'noise'].includes(verdict)) throw httpError(400, 'Verdict is useful, noise or null.');
        record.upsertRun({ ...run, verdict, opened: true });
        pushState();
        return send(res, 200, { ok: true });
      }
    }

    if (area === 'review') {
      if (id === 'close' && req.method === 'POST') return send(res, 200, closeMonth((await readBody(req)).month));
      if (id && req.method === 'GET') {
        if (!/^\d{4}-\d{2}$/.test(id) || !record.isClosed(id)) throw httpError(404, 'No review for that month yet.');
        return send(res, 200, { path: tilde(record.reviewPath(id)), text: read(record.reviewPath(id)) });
      }
    }

    // Preview an asset from a review card. Images only come from the managers' folders and HQ.
    if (area === 'file' && req.method === 'GET') {
      const file = allowedAsset(url.searchParams.get('path') || '');
      if (!file) throw httpError(404, 'File not found');
      res.writeHead(200, { 'content-type': ASSET_TYPES[path.extname(file).toLowerCase()], 'cache-control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }

    if ((area === 'reveal' || area === 'open') && req.method === 'POST') {
      const target = expand((await readBody(req)).path || '');
      if (!target.startsWith(HOME) || !fs.existsSync(target)) throw httpError(404, 'That file or folder isn\'t on this Mac.');
      if (area === 'open') {
        if (!allowedAsset(target)) throw httpError(403, 'HQ only opens images, PDFs and videos from your managers\' folders.');
        execFile('open', [target]);
      } else {
        // Always reveal in Finder, never open: a folder can be an app (Something.app) that would launch.
        execFile('open', ['-R', target]);
      }
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!err.status) console.error(err);
    send(res, err.status || 500, { error: err.message });
  }
});

// Desks and roles change when managers edit them: keep the screen in step.
try {
  fs.watch(path.join(HQ, 'managers'), { recursive: true }, (_, file) => { if (/\.md$/.test(String(file))) pushState(); });
  if (fs.existsSync(projectsPath)) fs.watch(projectsPath, () => pushState());
} catch {}

setInterval(() => writeAll(': ping\n\n'), 25000);
setInterval(() => routines.tick().catch(err => console.error('Routine check failed', err)), 5 * 60000);
setTimeout(() => routines.tick().catch(err => console.error('Routine check failed', err)), 20000);
setInterval(() => { pruneTasks(); record.trimFeed(); }, 3600e3);

// Anything that was running when HQ last stopped can't be reattached.
for (const task of store.state.tasks) {
  if (task.status === 'working') Object.assign(task, { status: 'interrupted', activity: '' });
}
pruneTasks();
store.saveNow();

function shutdown() {
  for (const [id, run] of workers) {
    const task = store.task(id);
    if (task) Object.assign(task, { status: 'interrupted', activity: '' });
    run.kill();
  }
  for (const l of Object.values(live)) l.run?.kill();
  store.saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// One bad request or file shouldn't take HQ down with every running manager and worker: log it and carry on.
process.on('uncaughtException', err => console.error('Unexpected error, HQ keeps running:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection, HQ keeps running:', err));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`HQ is running at http://localhost:${PORT}`);
  schedule();
});

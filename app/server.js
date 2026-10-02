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
import * as P from './lib/prompts.js';

const APP = path.dirname(fileURLToPath(import.meta.url));
const HQ = path.dirname(APP);
const HOME = os.homedir();
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

const MANAGERS = readJson(path.join(APP, 'managers.json'), []).map(m => ({
  ...m, homePath: expand(m.home), folderPaths: m.folders.map(expand),
}));
const byId = Object.fromEntries(MANAGERS.map(m => [m.id, m]));

const store = new Store(path.join(APP, 'data'));
const record = new Record(path.join(HQ, 'record'));
const routines = new Routines({ appDir: APP, record, onChange: () => pushState() });
const managerDir = id => path.join(HQ, 'managers', id);
const deskPath = id => path.join(managerDir(id), 'DESK.md');
const rolePath = id => path.join(managerDir(id), 'ROLE.md');
const projectsPath = path.join(HQ, 'PROJECTS.md');
P.configure({ owner: OWNER, projectsPath: tilde(projectsPath) });
const WAITING = P.waitingHeading();
fs.mkdirSync(path.join(HQ, 'managers'), { recursive: true });
const INBOX = path.join(HQ, 'inbox');
const MAX_UPLOAD = 100 * 1024 * 1024;
const aboutOwner = () => read(path.join(HQ, CONFIG.aboutMe)).replace(/^# .*\n+/, '') || `No profile yet. ${OWNER} can add one in ${CONFIG.aboutMe}.`;

// Background-only tools that make no sense for a manager or worker.
const NEVER = ['CronCreate', 'CronDelete', 'ScheduleWakeup', 'RemoteTrigger', 'Workflow', 'PushNotification'];
// Anything that leaves the computer. Blocked for workers until you approve. Managers can add their own in managers.json ("outward").
const OUTWARD = [
  'Bash(git push *)', 'Bash(git push)', 'Bash(git -c *push*)',
  'Bash(gh pr create *)', 'Bash(gh pr merge *)', 'Bash(gh release *)',
  'Bash(vercel *)', 'Bash(npx vercel *)', 'Bash(npm publish *)',
  ...['slack_send_message', 'slack_schedule_message', 'slack_create_canvas', 'slack_update_canvas']
    .map(t => `mcp__claude_ai_Slack__${t}`),
  ...['create_event', 'update_event', 'delete_event', 'respond_to_event']
    .map(t => `mcp__claude_ai_Google_Calendar__${t}`),
  ...['create-pages', 'update-page', 'create-comment', 'create-database', 'update-data-source', 'create-view',
    'update-view', 'move-pages', 'duplicate-page', 'create-folder', 'update-folder', 'send-message-to-session', 'spawn-session']
    .map(t => `mcp__claude_ai_Notion__notion-${t}`),
  'mcp__claude_ai_Claude_Docs__update', 'mcp__claude_ai_Claude_Docs__delete',
  'mcp__claude_ai_Adobe_for_creativity__asset_invite_collaborators', 'mcp__claude_ai_Adobe_for_creativity__asset_share_link',
];

// Files a review card may preview or open: deliverables inside the managers' folders and HQ.
const ASSET_ROOTS = [...new Set([HQ, ...MANAGERS.flatMap(m => m.folderPaths)])].map(r => { try { return fs.realpathSync(r); } catch { return r; } });
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
  return ASSET_ROOTS.some(root => real === root || real.startsWith(`${root}${path.sep}`)) ? real : null;
}

// ---------- live updates to the browser ----------

const clients = new Set();
function emit(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
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
    summary: daySummary({ managers: MANAGERS, calls: open, tasks, upcoming }),
    managers: MANAGERS.map(m => {
      const desk = read(deskPath(m.id));
      const l = live[m.id];
      const s = store.manager(m.id);
      return {
        id: m.id, name: m.name, blurb: m.blurb, hue: m.hue, icon: m.icon, color: m.color, home: m.home, folders: m.folders, starters: m.starters || [],
        busy: l.busy, activity: l.activity, queued: l.queue.length, started: !!s.sessionId,
        model: s.model || '', effort: s.effort || '', connectors: s.connectors !== false,
        context: s.sessionId ? s.contextTokens || 0 : 0, autoFresh: AUTO_FRESH_TOKENS,
        long: (s.contextTokens || 0) > AUTO_FRESH_TOKENS * 0.75 || conversationSize(s.sessionId) > 3e6,
        desk: { text: desk, sections: parseDesk(desk) },
      };
    }),
    tasks,
    feed: buildFeed(),
    upcoming,
    routines: { list: routines.scorecard(), ...routines.status() },
    month: monthStatus(),
  };
}

// ---------- managers: one ongoing conversation each ----------

const live = Object.fromEntries(MANAGERS.map(m => [m.id, { busy: false, queue: [], run: null, activity: '', partial: '', stopped: false, fresh: false }]));

const partialTimers = {};
function emitPartial(id) {
  if (partialTimers[id]) return;
  partialTimers[id] = setTimeout(() => {
    partialTimers[id] = null;
    emit('partial', { manager: id, text: live[id].partial, activity: live[id].activity, busy: live[id].busy });
  }, 50);
}

function pushChat(id, role, text) {
  const message = { id: crypto.randomUUID(), role, text, at: Date.now() };
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
    req.on('data', c => {
      size += c.length;
      if (size > MAX_UPLOAD) { reject(httpError(413, 'That file is over 100 MB. Share its path instead.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      fs.writeFileSync(target, Buffer.concat(chunks));
      resolve({ path: tilde(target), name: path.basename(target), kind: assetKind(target), size });
    });
    req.on('error', reject);
  });
}

// A path you paste may sit outside the folders a manager can read. Copy those into the inbox.
function bringFilesIn(text, readable) {
  const notes = [];
  const seen = new Set();
  for (const match of String(text).matchAll(/(?:~|\/Users\/)[^\n"'<>`]*?\.[A-Za-z0-9]{1,5}(?=[\s"'`),.;:]|$)/g)) {
    const shown = match[0];
    const abs = expand(shown);
    if (seen.has(abs) || !abs.startsWith(HOME)) continue;
    seen.add(abs);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
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

  const context = [];
  if (s.updates.length) context.push(`Updates since your last message:\n${s.updates.map(u => `- ${u}`).join('\n')}`);
  if (!fresh && s.roleSeenHash && s.roleSeenHash !== hash(role)) context.push(`Your role file changed. It now reads:\n\n${role}`);
  if (!fresh && (s.promptVersion || 1) < P.PROMPT_VERSION) context.push(`HQ has new instructions for you:\n\n${P.dashboardRules()}`);
  if (fresh || s.deskSeenHash !== hash(desk)) context.push(`Your desk right now:\n\n${desk}`);
  const prompt = context.length ? `<hq-context>\n${context.join('\n\n')}\n</hq-context>\n\n${text}` : text;
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
      manager: m, role, deskPath: tilde(deskPath(id)), roleDir: tilde(managerDir(id)), folders: m.folders, aboutOwner: aboutOwner(),
    }),
    addDirs: [HQ, ...m.folderPaths.filter(f => f !== m.homePath && fs.existsSync(f))],
    allowed: ['Bash(hq-task *)'],
    disallowed: [...NEVER, ...(m.blocked || [])],
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
            lastText = block.text;
            pushChat(id, 'manager', block.text);
          } else if (block.type === 'tool_use') {
            l.partial = '';
            l.activity = describeTool(block.name, block.input);
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
        if (!wroteText && result.result) { lastText = result.result; pushChat(id, 'manager', result.result); }
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
  brief = bringFilesIn(brief, [INBOX, managerDir(manager), ...m.folderPaths]);
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
  const prompt = fresh ? P.workerBrief({ task, desk: read(deskPath(m.id)) }) : next?.prompt || P.CARRY_ON;

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
    addDirs: [managerDir(m.id), ...(fs.existsSync(INBOX) ? [INBOX] : []), ...m.folderPaths.filter(f => f !== folder && fs.existsSync(f))],
    disallowed: [...NEVER, ...(m.blocked || []), ...(unlocked ? [] : [...OUTWARD, ...(m.outward || [])])],
    onEvent: e => {
      if (e.type === 'system' && e.subtype === 'init') { task.sessionId = e.session_id; store.save(); return; }
      if (e.parent_tool_use_id || e.type !== 'assistant') return;
      for (const block of e.message?.content || []) {
        if (block.type === 'tool_use') {
          task.activity = describeTool(block.name, block.input);
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
        const report = result.result || lastText;
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
        task.error = friendlyError(result, stderr, code);
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
  const file = record.writeReview(key, { managers: MANAGERS, scorecard: routines.scorecard(key), desks });
  record.addEvent({ kind: 'system', text: `${monthLabel(key)} closed. Review written` });
  pushState();
  return { path: tilde(file), text: read(file) };
}

// ---------- HTTP ----------

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
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

    if (area === 'state' && req.method === 'GET') return send(res, 200, snapshot());

    if (area === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (area === 'managers' && byId[id]) {
      if (action === 'chat' && req.method === 'GET') {
        const l = live[id];
        return send(res, 200, { messages: store.chat(id).slice(-600), partial: l.partial, busy: l.busy, activity: l.activity });
      }
      if (action === 'message' && req.method === 'POST') {
        const { text } = await readBody(req);
        if (!String(text || '').trim()) throw httpError(400, 'Type a message first.');
        const m = byId[id];
        sendToManager(id, bringFilesIn(String(text).trim(), [HQ, ...m.folderPaths]), String(text).trim());
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
      if (!id && req.method === 'POST') return send(res, 200, createTask(await readBody(req)));
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
        execFile('open', fs.statSync(target).isDirectory() ? [target] : ['-R', target]);
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

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`HQ is running at http://localhost:${PORT}`);
  schedule();
});

// The team: what a router (General) can reach, and new managers that an agent proposes and the owner approves.
import fs from 'node:fs';
import path from 'node:path';
import { badFolder } from './safety.js';

// Glyphs a manager can use (app.js draws them). home, routine and project are HQ's own.
export const ICONS = ['globe', 'chat', 'chart', 'sparkle', 'pen', 'code', 'megaphone', 'briefcase', 'search', 'bolt', 'book', 'users', 'star', 'film'];
const COLORS = ['#FF9500', '#34C759', '#00C7BE', '#32ADE6', '#5856D6', '#FF2D55', '#A2845E', '#AF52DE', '#5E5CE6', '#30B0C7'];
export const MANAGER_ID = /^[a-z][a-z0-9-]{1,23}$/;
const RESERVED = new Set(['propose', 'proposals', 'new', 'all', 'hq', 'app']);

// A router works across the whole team: its own folders plus every other manager's, worked out each time,
// so a manager added later is covered without a restart.
export function teamFolders(m, managers) {
  if (!m.router) return m.folderPaths;
  return [...new Set([m.homePath, ...m.folderPaths, ...managers.filter(x => x.id !== m.id).flatMap(x => x.folderPaths)])];
}

// A router also carries every manager's own blocks ("blocked", "outward"), so working in their folders never gets round them.
export const teamRules = (m, managers, key) => (m.router ? [...new Set(managers.flatMap(x => x[key] || []))] : m[key] || []);

// The nearest existing folder's real path, plus the rest: catches a link that points into HQ's app.
function realish(p) {
  let base = p;
  const rest = [];
  while (!fs.existsSync(base) && path.dirname(base) !== base) { rest.unshift(path.basename(base)); base = path.dirname(base); }
  try { return path.join(fs.realpathSync(base), ...rest); } catch { return p; }
}

const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

// Check a proposal before it's stored, and again before it's approved. Throws a plain-English error the agent can
// act on. ctx: { managers, proposals, home, hq, app, taken(id), clean(text) }.
export function checkProposal(body, ctx) {
  const b = body && typeof body === 'object' ? body : {};
  const clean = ctx.clean || (s => s);
  const str = (key, max, required = true) => {
    const v = clean(b[key] == null ? '' : String(b[key])).trim();
    if (required && !v) fail(`The proposal needs a "${key}".`);
    if (v.length > max) fail(`"${key}" is too long: keep it under ${max} characters.`);
    return v;
  };

  const id = str('id', 24);
  if (!MANAGER_ID.test(id)) fail('"id" is 2 to 24 lowercase letters, digits or dashes, starting with a letter, like "newsletter".');
  if (RESERVED.has(id)) fail(`"${id}" is reserved. Pick another id.`);
  if (ctx.managers.some(m => m.id === id)) fail(`There's already a manager with the id "${id}".`);
  if (ctx.proposals.some(p => p.id === id)) fail(`A manager with the id "${id}" is already waiting for approval.`);
  if (ctx.taken?.(id)) fail(`managers/${id}/ still holds an earlier manager's role or desk. Pick another id.`);

  const name = str('name', 40);
  if ([...ctx.managers, ...ctx.proposals].some(m => m.name.toLowerCase() === name.toLowerCase())) fail(`There's already a manager called ${name}.`);
  const blurb = str('blurb', 80);
  const icon = str('icon', 20);
  if (!ICONS.includes(icon)) fail(`"icon" is one of ${ICONS.join(', ')}.`);
  let color = str('color', 7, false);
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) fail('"color" is a hex colour like #FF9500.');
  if (!color) color = COLORS.find(c => !ctx.managers.some(m => String(m.color).toLowerCase() === c.toLowerCase())) || COLORS[0];

  // Folders: home first. Each is checked as written and as it really is on disk.
  const real = { home: realish(ctx.home), hq: realish(ctx.hq), app: realish(ctx.app) };
  const folder = raw => {
    const text = clean(String(raw ?? '')).trim();
    if (!/^(~\/|\/)/.test(text)) fail(`Folder "${text}" must start with ~/.`);
    const abs = path.resolve(text.replace(/^~(?=\/)/, ctx.home));
    const problem = badFolder(abs, ctx) || badFolder(realish(abs), real);
    if (problem) fail(`Folder ${text} ${problem}.`);
    return abs;
  };
  const home = folder(str('home', 200));
  const extra = b.folders == null ? [] : Array.isArray(b.folders) ? b.folders : fail('"folders" is a list, like ["~/newsletter", "~/website"].');
  if (extra.length > 8) fail('Keep it to eight folders or fewer.');
  const folders = [...new Set([home, ...extra.map(folder)])];
  const tilde = p => (p.startsWith(ctx.home) ? `~${p.slice(ctx.home.length)}` : p);

  let role = str('role', 6000);
  if (!/^#\s/.test(role)) role = `# ${name}\n\n${role}`;

  const steps = Array.isArray(b.firstSteps) ? b.firstSteps : b.firstSteps ? String(b.firstSteps).split('\n') : [];
  const firstSteps = steps.map(s => clean(String(s)).replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (firstSteps.length > 5 || firstSteps.some(s => s.length > 200)) fail('"firstSteps" is up to five short lines.');

  let handoff = null;
  if (b.handoff) {
    const title = clean(String(b.handoff.title ?? '')).replace(/\s+/g, ' ').trim();
    const brief = clean(String(b.handoff.brief ?? '')).trim();
    if (!title || !brief) fail('"handoff" needs a "title" and a "brief", or leave it out.');
    if (title.length > 120 || brief.length > 20000) fail('The handoff is too long: a title under 120 characters, a brief under 20,000.');
    handoff = { title, brief };
  }
  return { id, name, blurb, icon, color, home: tilde(home), folders: folders.map(tilde), role, firstSteps, handoff };
}

// The managers.json entry for an approved proposal. New managers get no network and no blocks: the owner adds those.
export const managerEntry = p => ({
  id: p.id, name: p.name, blurb: p.blurb, icon: p.icon, color: p.color, home: p.home, folders: p.folders,
  starters: ["What's on your desk?"],
});

// A desk with the same sections as every other manager's.
export function deskFor({ name, waiting, firstSteps = [], note = '' }) {
  return [
    `# ${name}: desk`, '', '## Working on', '', '## Next', ...firstSteps.map(s => `- ${s}`), '',
    `## ${waiting}`, '', '## Waiting on others', '', '## Decisions', '', '## Parked', '', '## Notes', ...(note ? [`- ${note}`] : []), '',
  ].join('\n');
}

// Add a manager to managers.json without ever leaving it half-written: read it fresh, write a copy, swap it in.
export function appendManager(file, entry) {
  let list;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = fs.existsSync(file) ? null : []; }
  if (!Array.isArray(list)) fail(`${path.basename(file)} isn't a list HQ can read. Fix it, then approve again.`);
  if (list.some(m => m.id === entry.id)) fail(`${path.basename(file)} already has a manager "${entry.id}".`);
  list.push(entry);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return list;
}

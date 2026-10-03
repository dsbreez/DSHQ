// Small safety checks: which app is on the other end of a connection, and which files never leave their folder.
import { execFile } from 'node:child_process';
import path from 'node:path';

// ---------- choices only the owner makes ----------
// Approve, answer, mark done and the like must come from a browser on this Mac, never from a script a
// manager or worker runs.

// The process that makes a browser's network requests, by the name macOS gives it (lsof).
export const BROWSERS = new Set([
  'com.apple.WebKit.Networking', // Safari, and Safari web apps in the Dock
  'Google Chrome', 'Google Chrome Helper', 'Chromium', 'Chromium Helper', 'Arc', 'Arc Helper', 'Browser Helper',
  'Brave Browser', 'Brave Browser Helper', 'Microsoft Edge', 'Microsoft Edge Helper', 'firefox', 'Firefox',
  'Claude Helper', // the Claude desktop app's browser pane
]);
// A real browser runs from /Applications or comes with macOS. A copy of node renamed "Google Chrome Helper"
// in a temp folder doesn't count. Managers and workers can't write to either place: their Bash is sandboxed.
const TRUSTED = /^\/(Applications|System)\//;

// lsof -Fpcn output for the client's port → the processes holding the client end of the connection.
// HQ holds the other end (local port = HQ's port), so it never matches.
export function clientProcesses(text, { clientPort, serverPort }) {
  const found = new Map();
  let cur = null;
  for (const line of String(text).split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') cur = { pid: Number(value), name: '' };
    else if (tag === 'c' && cur) cur.name = value;
    else if (tag === 'n' && cur) {
      const ends = value.match(/:(\d+)->.*:(\d+)$/);
      if (ends && Number(ends[1]) === clientPort && Number(ends[2]) === serverPort) found.set(cur.pid, cur);
    }
  }
  return [...found.values()];
}

// lsof -p <pid> -a -d txt -Fn output → the program file the process runs (the first txt entry).
export function programPath(text) {
  return String(text).split('\n').find(l => l.startsWith('n'))?.slice(1) || '';
}

export const isBrowser = ({ name, exe }) => BROWSERS.has(name) && TRUSTED.test(exe || '');

const run = (cmd, args) => new Promise(resolve => {
  execFile(cmd, args, { timeout: 5000 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)));
});

async function check(clientPort, serverPort) {
  try {
    const procs = clientProcesses(await run('/usr/sbin/lsof', ['-nP', `-iTCP:${clientPort}`, '-sTCP:ESTABLISHED', '-Fpcn']), { clientPort, serverPort });
    if (!procs.length) return false;
    for (const p of procs) p.exe = programPath(await run('/usr/sbin/lsof', ['-nP', '-p', String(p.pid), '-a', '-d', 'txt', '-Fn']));
    return procs.every(isBrowser);
  } catch {
    return false;
  }
}

// One check per connection: a browser keeps its connection open across clicks.
const seen = new WeakMap();
export function fromBrowser(req, serverPort) {
  const socket = req.socket;
  if (!seen.has(socket)) seen.set(socket, check(socket.remotePort, serverPort));
  return seen.get(socket);
}

// ---------- files HQ never copies ----------
// A pasted path outside a manager's folders is copied into the inbox, except these: anything outside the home
// folder, hidden files and folders (.ssh, .aws, .config, .env, .git…), the keychains, and anything named like
// a key, token, secret, password or credential.
export function privatePath(abs, home) {
  const rel = path.relative(home, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return true;
  const parts = rel.split(path.sep);
  const name = parts.at(-1).toLowerCase();
  return parts.some(p => p.startsWith('.')) || /^library\/keychains(\/|$)/i.test(rel)
    || /key|token|secret|credential|password|\.pem$|\.p12$|\.pfx$/.test(name) || name.startsWith('id_');
}

// ---------- folders a new manager may work in ----------
// A proposed manager is drafted by an agent, so its folders are checked before the owner sees the card: inside
// the home folder, not hidden, not Library, and never HQ's own folder or its app (code, settings, private data).
// Returns what's wrong, or '' when the folder is fine. Check the real path too, so a link can't point past this.
export function badFolder(abs, { home, hq, app }) {
  const inside = (p, root) => p === root || p.startsWith(`${root}${path.sep}`);
  const rel = path.relative(home, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return 'must be a folder inside the home folder';
  if (rel.split(path.sep).some(p => p.startsWith('.'))) return "can't be a hidden folder";
  if (/^library(\/|$)/i.test(rel)) return "can't be in Library";
  if (abs === hq) return "can't be HQ's own folder (a folder inside it is fine)";
  if (inside(abs, app)) return "can't be HQ's app folder or anything in it";
  return '';
}

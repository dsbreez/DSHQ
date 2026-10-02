// Runs Claude Code in headless mode and streams its events back.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const CLAUDE = process.env.HQ_CLAUDE_BIN || (fs.existsSync(path.join(HOME, '.local/bin/claude')) ? path.join(HOME, '.local/bin/claude') : 'claude');
const APP_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');

function childEnv() {
  const env = { ...process.env };
  // Don't let a parent Claude Code session leak into the children.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  const extra = [path.resolve(APP_BIN), path.dirname(process.execPath), path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  env.PATH = [...extra, env.PATH || '/usr/bin:/bin'].join(':');
  return env;
}

export function runClaude({ cwd, prompt, sessionId, resume, name, appendSystemPrompt, addDirs = [], allowed = [], disallowed = [], settings, partial = false, model, effort, autocompact, connectors = true, onEvent, onExit }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompts', 'none'];
  if (resume) args.push('--resume', resume);
  else if (sessionId) args.push('--session-id', sessionId);
  if (name) args.push('--name', name);
  if (partial) args.push('--include-partial-messages');
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (autocompact) args.push('--autocompact', String(autocompact));
  if (!connectors) args.push('--strict-mcp-config');
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
  if (addDirs.length) args.push('--add-dir', ...addDirs);
  if (allowed.length) args.push('--allowedTools', ...allowed);
  if (disallowed.length) args.push('--disallowedTools', ...disallowed);
  // Settings for this run only, such as the Bash sandbox. Claude Code merges them over the user's own.
  if (settings) args.push('--settings', JSON.stringify(settings));

  const proc = spawn(CLAUDE, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  let result = null;
  let sawInit = false;

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'system' && event.subtype === 'init') sawInit = true;
      if (event.type === 'result') result = event;
      try { onEvent?.(event); } catch (err) { console.error('onEvent failed', err); }
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  proc.on('error', err => { stderr += `\n${err.message}`; });
  proc.on('close', (code, signal) => {
    onExit?.({ code, signal, stderr: stderr.trim(), result, sawInit });
  });

  proc.stdin.end(prompt);
  return { proc, kill: () => { try { proc.kill('SIGTERM'); } catch {} } };
}

// A one-off headless run that returns Claude's final message. Used for small background jobs.
export function runClaudeOnce({ cwd, prompt, args = [], timeoutMs = 10 * 60000 }) {
  return new Promise(resolve => {
    const proc = spawn(CLAUDE, ['-p', '--output-format', 'json', '--no-session-persistence', ...args], {
      cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGTERM'), timeoutMs);
    proc.stdout.on('data', c => { out += c; });
    proc.stderr.on('data', c => { err = (err + c).slice(-4000); });
    proc.on('error', e => { err += e.message; });
    proc.on('close', code => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out); } catch {}
      resolve({ ok: !!parsed && !parsed.is_error, result: parsed?.result || '', error: parsed?.is_error ? parsed.result : err.trim() || (code ? `exit ${code}` : '') });
    });
    proc.stdin.end(prompt);
  });
}

// One plain-English line for what a tool call is doing.
export function describeTool(name, input = {}) {
  const base = p => (p ? path.basename(String(p)) : 'a file');
  const clip = (s, n = 70) => { s = String(s || '').split('\n')[0]; return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  switch (name) {
    case 'Read': return `Reading ${base(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${base(input.file_path)}`;
    case 'Write': return `Writing ${base(input.file_path)}`;
    case 'NotebookEdit': return `Editing ${base(input.notebook_path)}`;
    case 'Bash':
      if (/\bhq-task\s+new\b/.test(input.command || '')) return 'Starting a worker';
      return clip(input.description || `Running ${input.command}`);
    case 'Grep': return `Searching for “${clip(input.pattern, 40)}”`;
    case 'Glob': return `Looking for ${clip(input.pattern, 50)}`;
    case 'WebSearch': return `Searching the web for “${clip(input.query, 50)}”`;
    case 'WebFetch': try { return `Reading ${new URL(input.url).hostname}`; } catch { return 'Reading a web page'; }
    case 'Skill': return `Using the ${input.skill || input.name || ''} skill`;
    case 'Task': case 'Agent': return input.description ? `Helper: ${clip(input.description, 60)}` : 'Handing part of it to a helper';
    case 'TodoWrite': return 'Planning the steps';
    case 'ToolSearch': return 'Loading tools';
    default:
      if (name.startsWith('mcp__')) {
        const [, server = '', tool = ''] = name.split('__');
        return `${server.replace(/^claude_ai_/, '').replace(/_/g, ' ')}: ${tool.replace(/[-_]/g, ' ')}`;
      }
      return name;
  }
}

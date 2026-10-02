// Scheduled routines: what's due, what ran, and whether it was worth it.
// Cloud routines run on claude.ai. HQ checks on them a few times a day with a small read-only Claude job,
// and only when a routine was due to have run since the last check.
import fs from 'node:fs';
import path from 'node:path';
import { firesBetween, nextFire, describeCron } from './cron.js';
import { monthKey } from './record.js';
import { runClaudeOnce } from './claude.js';

const GRACE = 15 * 60000;   // cloud runs start up to ~12 minutes late
const REPLY_GAP = 5 * 60000; // activity this long after a run finished means you answered it

export class Routines {
  constructor({ appDir, record, onChange }) {
    this.configPath = path.join(appDir, 'routines.json');
    this.statePath = path.join(appDir, 'data', 'routines-state.json');
    this.workDir = path.join(appDir, 'data', 'sync');
    fs.mkdirSync(this.workDir, { recursive: true });
    this.record = record;
    this.onChange = onChange;
    this.config = this.loadConfig();
    this.state = { lastChecked: {}, lastFullSync: 0, lastSyncAt: 0, lastError: '', ...readJson(this.statePath, {}) };
    this.syncing = false;
  }

  loadConfig() {
    return readJson(this.configPath, []).map(r => ({ ...r, utc: r.where !== 'mac' }));
  }

  save() {
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  // Called every few minutes.
  async tick() {
    if (this.syncing) return;
    const now = Date.now();
    const cloud = this.config.filter(r => r.where !== 'mac' && r.enabled !== false);
    const due = cloud.filter(r => {
      const from = this.state.lastChecked[r.id] || now - 26 * 3600e3;
      return firesBetween(r.cron, from, now - GRACE, true).length > 0;
    });
    const startOfDay = new Date().setHours(0, 0, 0, 0);
    const fullDue = new Date().getHours() >= 17 && this.state.lastFullSync < startOfDay;
    if (fullDue) await this.sync(cloud, true);
    else if (due.length) await this.sync(due, false);
  }

  syncNow() {
    return this.sync(this.config.filter(r => r.where !== 'mac' && r.enabled !== false), true);
  }

  async sync(routines, full) {
    if (this.syncing || !routines.length) return;
    this.syncing = true;
    this.onChange();
    const now = Date.now();
    const asks = routines.map(r => {
      const since = full ? now - 7 * 864e5 : (this.state.lastChecked[r.id] || now - 26 * 3600e3) - 3600e3;
      const known = [...this.record.runs.values()]
        .filter(x => x.routine_id === r.id && Date.parse(x.created_at) > since && x.ended_at)
        .map(x => x.session_id);
      return { trigger_id: r.id, since: new Date(since).toISOString(), known };
    });
    const prompt = `Use only the RemoteTrigger tool, and only its read actions list_runs and get_run_log. Never create, update or run anything.

For each routine below, call list_runs with its trigger_id and look at runs created after its "since" time.
- For every such run, include session_id, created_at, last_event_at and url.
- If the session_id is NOT in "known", also call get_run_log for it. Find the final line that starts with "result:". Use that line's timestamp as ended_at, set ok to true unless it says is_error=true, and set outcome to the text after the dash (max 200 characters). If there is no result line, set ok to false and outcome to the last error you can see, or "No result".

Routines:
${JSON.stringify(asks, null, 2)}

Reply with only this JSON and nothing else:
{"runs":[{"routine_id":"","session_id":"","created_at":"","last_event_at":"","ended_at":"","ok":true,"url":"","outcome":""}]}`;

    const res = await runClaudeOnce({
      cwd: this.workDir,
      prompt,
      args: ['--model', 'haiku', '--effort', 'low', '--tools', 'RemoteTrigger', '--allowedTools', 'RemoteTrigger',
        '--permission-mode', 'dontAsk', '--strict-mcp-config', '--disable-slash-commands'],
    });
    this.syncing = false;
    this.state.lastSyncAt = Date.now();
    const parsed = res.ok ? extractJson(res.result) : null;
    if (!parsed?.runs) {
      // Keep what came back, so a failed check can be diagnosed.
      fs.writeFileSync(path.join(this.workDir, 'last-failed.txt'), `${new Date().toISOString()}\nerror: ${res.error}\n\n${res.result}`);
      this.state.lastError = res.error || 'The check came back in an unexpected shape.';
      this.save();
      this.onChange();
      return;
    }
    this.state.lastError = '';
    const names = Object.fromEntries(this.config.map(r => [r.id, r.name]));
    for (const run of parsed.runs) {
      if (!run.session_id || !names[run.routine_id]) continue;
      const prev = this.record.run(run.session_id) || {};
      const merged = { ...prev, routine_id: run.routine_id, routine: names[run.routine_id], session_id: run.session_id };
      for (const k of ['created_at', 'last_event_at', 'url', 'ended_at', 'outcome']) if (run[k]) merged[k] = run[k];
      if (!prev.ended_at && typeof run.ok === 'boolean') merged.ok = run.ok;
      if (merged.ended_at && merged.last_event_at) {
        merged.replied = Date.parse(merged.last_event_at) - Date.parse(merged.ended_at) > REPLY_GAP;
      }
      this.record.upsertRun(merged);
    }
    for (const r of routines) this.state.lastChecked[r.id] = now - GRACE;
    if (full) this.state.lastFullSync = now;
    this.save();
    this.onChange();
  }

  upcomingToday() {
    const now = Date.now();
    const end = new Date().setHours(23, 59, 59, 999);
    return this.config
      .filter(r => r.enabled !== false)
      .flatMap(r => firesBetween(r.cron, now, end, r.utc).map(at => ({ routine: r.name, routine_id: r.id, at, where: r.where })))
      .sort((a, b) => a.at - b.at);
  }

  scorecard(key = monthKey()) {
    const runs = this.record.monthRuns(key);
    return this.config.map(r => {
      const mine = runs.filter(x => x.routine_id === r.id);
      const count = k => mine.filter(x => x[k]).length;
      const useful = mine.filter(x => x.verdict === 'useful').length;
      const noise = mine.filter(x => x.verdict === 'noise').length;
      const engaged = mine.filter(x => x.verdict === 'useful' || x.replied).length;
      const tracked = r.where !== 'mac';
      let hint = 'Too early to tell';
      if (!tracked) hint = 'Runs on your Mac, not tracked yet';
      else if (mine.length >= 4) {
        if (noise > useful && noise >= 2) hint = 'Looks like noise: pause or merge';
        else if (engaged / mine.length >= 0.5) hint = 'Keep';
        else if (count('opened') / mine.length < 0.25 && !useful) hint = 'Rarely opened: pause or merge';
        else hint = 'Mixed: keep watching';
      }
      return {
        id: r.id, name: r.name, where: r.where, tracked, schedule: describeCron(r.cron, r.utc), next: nextFire(r.cron, Date.now(), r.utc),
        runs: mine.length, opened: count('opened'), replied: count('replied'), useful, noise, failed: mine.filter(x => x.ok === false).length, hint,
      };
    });
  }

  status() {
    return { syncing: this.syncing, lastSyncAt: this.state.lastSyncAt, lastError: this.state.lastError };
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

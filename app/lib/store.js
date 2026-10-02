// Small JSON-file persistence: app state, one chat file per manager, one log per task.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'chat'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    this.statePath = path.join(dir, 'state.json');
    this.state = readJson(this.statePath, { nextTaskId: 1, managers: {}, tasks: [] });
    this.chats = {};
    this.timer = null;
  }

  manager(id) {
    return (this.state.managers[id] ??= { sessionId: null, deskSeenHash: null, updates: [] });
  }

  chat(id) {
    return (this.chats[id] ??= readJson(path.join(this.dir, 'chat', `${id}.json`), []));
  }

  saveChat(id) {
    writeJson(path.join(this.dir, 'chat', `${id}.json`), this.chat(id));
  }

  task(id) {
    return this.state.tasks.find(t => t.id === Number(id));
  }

  log(taskId, entry) {
    fs.appendFileSync(path.join(this.dir, 'logs', `${taskId}.jsonl`), `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
  }

  readLog(taskId, limit = 400) {
    try {
      const lines = fs.readFileSync(path.join(this.dir, 'logs', `${taskId}.jsonl`), 'utf8').trim().split('\n');
      return lines.slice(-limit).map(l => JSON.parse(l));
    } catch { return []; }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 150);
  }

  saveNow() {
    clearTimeout(this.timer);
    writeJson(this.statePath, this.state);
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

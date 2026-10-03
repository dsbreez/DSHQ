// HQ front end: the home queue, one conversation per manager, and a sheet per task. No framework.

const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  loaded: false, version: 0, managers: [], tasks: [], feed: [], upcoming: [], routines: { list: [] }, month: {},
  calls: [], projects: [], summary: '', answered: new Map(), replying: null, projectDone: new Set(), unclearOpen: false, approvingWith: null,
  chats: {}, partial: {}, live: {}, chipsSent: {},
  proposals: [], updates: { for: '', weeks: [] }, updatesWeek: 0,
  view: null, openTask: null, taskLog: { id: null, entries: [], fetchedFor: 0 },
  deskEditing: false, earlierOpen: false, openRun: null, openSteps: new Set(),
};

const prefs = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-hq': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

// Only touch the DOM when the markup actually changed, so focus and scroll survive updates.
// Fields marked data-keep hold on to what you've typed, and to focus, when their section redraws.
function setHTML(el, html) {
  if (!el || el._html === html) return;
  const kept = [...el.querySelectorAll('[data-keep]')].map(f => ({
    key: f.dataset.keep, value: f.value, focused: document.activeElement === f, start: f.selectionStart, end: f.selectionEnd,
  }));
  el.innerHTML = html;
  el._html = html;
  for (const k of kept) {
    const f = el.querySelector(`[data-keep="${CSS.escape(k.key)}"]`);
    if (!f) continue;
    f.value = k.value;
    if (k.focused) { f.focus(); try { f.setSelectionRange(k.start, k.end); } catch {} }
  }
}

// ---------- formatting ----------

function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function elapsed(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'under a minute';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const fmtK = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const clock = ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayTime = ts => new Date(ts).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

const SVG = (body, attrs = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"') =>
  `<svg viewBox="0 0 16 16" ${attrs} aria-hidden="true">${body}</svg>`;
const FOLDER_GLYPH = SVG('<path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3.2l1.5 1.5H13a1.5 1.5 0 0 1 1.5 1.5v5.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5z"/>', 'fill="currentColor"');
const FILE_GLYPH = SVG('<path d="M4 1.5h5L12.5 5v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z"/>', 'fill="currentColor"');
const CHECK_GLYPH = SVG('<path d="M3.5 8.5l3 3 6-7"/>', 'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"');
const CLOSE_GLYPH = SVG('<path d="M4 4l8 8M12 4l-8 8"/>', 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"');
const SEND_GLYPH = SVG('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>', 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"');
const CLIP_GLYPH = SVG('<path d="M13.2 7.6l-5.4 5.4a3.1 3.1 0 0 1-4.4-4.4l5.6-5.6a2.1 2.1 0 0 1 3 3l-5.5 5.5a1 1 0 0 1-1.5-1.5l5-5"/>', 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"');
const STOP_GLYPH = SVG('<rect x="4" y="4" width="8" height="8" rx="1.5"/>', 'fill="currentColor"');

const isPath = s => /^(~\/|\/Users\/)\S*$/.test(s);
const pathName = p => p.replace(/\/+$/, '').split('/').pop() || p;
const pathBtn = (p, label = pathName(p)) =>
  `<button type="button" class="path" data-path="${esc(p)}" title="${esc(p)}: show in Finder">${/\.[a-z0-9]+$/i.test(pathName(p)) ? FILE_GLYPH : FOLDER_GLYPH}${esc(label)}</button>`;

// Small markdown renderer: headings, lists, tables, code, quotes, links. Everything is escaped first.
function inline(src) {
  const codes = [];
  let s = String(src ?? '').replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  const link = (url, text) => {
    if (/^(https?:|mailto:)/i.test(url)) return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
    const raw = url.replace(/&amp;/g, '&');
    return isPath(raw) ? pathBtn(raw, text.replace(/&amp;/g, '&')) : text;
  };
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => link(url, text));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, pre, url) => pre + link(url, url));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => (isPath(codes[n]) ? pathBtn(codes[n]) : `<code>${esc(codes[n])}</code>`));
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function mdList(lines, start) {
  const indent = l => l.match(/^\s*/)[0].length;
  const base = indent(lines[start]);
  const ordered = /^\s*\d+[.)]\s/.test(lines[start]);
  let html = '';
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST_RE);
    if (!m) {
      const next = lines[i + 1];
      if (!lines[i].trim() && next && LIST_RE.test(next) && indent(next) >= base) { i++; continue; }
      break;
    }
    if (m[1].length < base) break;
    if (m[1].length === base && /\d/.test(m[2]) !== ordered) break;
    if (m[1].length > base) {
      const [sub, next] = mdList(lines, i);
      html = html.replace(/<\/li>$/, `${sub}</li>`);
      i = next;
      continue;
    }
    let text = m[3];
    i++;
    while (i < lines.length && lines[i].trim() && !LIST_RE.test(lines[i]) && indent(lines[i]) > base) text += `\n${lines[i++].trim()}`;
    const box = text.match(/^\[([ xX])\]\s+([\s\S]*)$/);
    html += box ? `<li class="check${box[1].trim() ? ' is-done' : ''}">${inline(box[2])}</li>` : `<li>${inline(text)}</li>`;
  }
  return [ordered ? `<ol>${html}</ol>` : `<ul>${html}</ul>`, i];
}

function md(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  const para = [];
  let html = '';
  let i = 0;
  const flush = () => { if (para.length) { html += `<p>${inline(para.join('\n'))}</p>`; para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); const level = Math.min(h[1].length + 1, 5); html += `<h${level}>${inline(h[2])}</h${level}>`; i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); html += '<hr>'; i++; continue; }
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] || '')) {
      flush();
      const row = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = row(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) body.push(row(lines[i++]));
      html += `<div class="table"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${md(buf.join('\n'))}</blockquote>`;
      continue;
    }
    if (LIST_RE.test(line)) { flush(); const [list, next] = mdList(lines, i); html += list; i = next; continue; }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return html;
}

const mdCache = new Map();
const mdCached = (key, text) => {
  if (!mdCache.has(key)) mdCache.set(key, md(text));
  return mdCache.get(key);
};

// The desk without its title and without empty sections.
function deskForDisplay(text) {
  const body = String(text || '').replace(/^#\s.*\n+/, '').replace(/\s*\[[^\]\n]+\]\s*$/gm, '');
  const parts = body.split(/^(?=##\s)/m);
  return parts.filter(p => !/^##\s/.test(p) || p.replace(/^##.*\n?/, '').trim()).join('');
}

// ---------- model helpers ----------

const mgr = id => S.managers.find(m => m.id === id);
const shortName = m => m.name.replace(/ Manager$/, '');

// Icon tiles in the style of System Settings: a white glyph on a colour.
// Managers pick a glyph and colour in managers.json ("icon", "color"); without one they get their initial.
const GLYPHS = {
  home: '<path d="M4.5 10.2 12 4.5l7.5 5.7V19a1 1 0 0 1-1 1H15v-5.5H9V20H5.5a1 1 0 0 1-1-1z"/>',
  routine: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  project: '<rect x="4.5" y="5" width="15" height="14" rx="2.5"/><path d="M8.5 10h7M8.5 14h4.5"/>',
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.1 2.3 3.2 5 3.2 8s-1.1 5.7-3.2 8c-2.1-2.3-3.2-5-3.2-8s1.1-5.7 3.2-8z"/>',
  chat: '<path d="M6.5 5h11A2.5 2.5 0 0 1 20 7.5v6a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 3.5V16h-1A2.5 2.5 0 0 1 4 13.5v-6A2.5 2.5 0 0 1 6.5 5z"/>',
  chart: '<path d="M4 17.5l5.2-5.2 3.8 3.2L20 8.5"/><path d="M15 8.5h5v5"/>',
  sparkle: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  pen: '<path d="M14.5 5.5l4 4L9 19H5v-4z"/><path d="M12.5 7.5l4 4"/>',
  code: '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>',
  megaphone: '<path d="M4.5 10v4h3l7 4V6l-7 4z"/><path d="M18 9.5a3.5 3.5 0 0 1 0 5"/>',
  briefcase: '<rect x="4" y="7.5" width="16" height="11" rx="2"/><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5M4 12.5h16"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/>',
  bolt: '<path d="M13 3.5L6 13h5l-1 7.5L17 11h-5z"/>',
  book: '<path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H18v14H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H18"/>',
  users: '<circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 6.5a3 3 0 0 1 0 5.5M17.5 19a5.5 5.5 0 0 0-2.5-4.6"/>',
  star: '<path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/>',
  film: '<rect x="4" y="5.5" width="16" height="13" rx="3"/><path d="M10.5 9.5v5l4-2.5z"/>',
  updates: '<path d="M9.5 7.5h9M9.5 12h9M9.5 16.5h6"/><path d="M5.5 7.5h.01M5.5 12h.01M5.5 16.5h.01"/>',
};
const TINTS = { home: '#0A7AFF', routine: '#8E8E93', project: '#FF9F0A', updates: '#34C759' };
function tile(key, size = '', hue = 250, letter = '', color = '') {
  const glyph = GLYPHS[key];
  const tint = color || TINTS[key] || `oklch(0.6 0.14 ${hue})`;
  return `<span class="tile ${size}" style="--tint:${esc(tint)}" aria-hidden="true">${glyph
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>`
    : esc(letter)}</span>`;
}
const avatar = (m, size = '') => tile(m.icon, size, m.hue, m.name[0], m.color);

const tasksOf = id => S.tasks.filter(t => t.manager === id);
const NEEDS = new Set(['review', 'failed', 'interrupted', 'stopped']);
const needsYou = () => S.tasks.filter(t => NEEDS.has(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
// Questions sitting on a manager's desk under "Waiting on <you>".
const deskAsks = (id = null) => S.managers
  .filter(m => !id || m.id === id)
  .flatMap(m => (m.desk.sections[S.waitingHeading] || m.desk.sections['Waiting on you'] || []).map(text => ({ manager: m, text })));
const needsCount = (id = null) => (id ? tasksOf(id) : S.tasks).filter(t => NEEDS.has(t.status)).length
  + (S.proposals || []).filter(p => !id || p.from === id).length
  + (S.version ? S.calls.filter(c => (!id || c.manager === id) && !S.answered.has(`${c.manager}|${c.raw}`)).length : deskAsks(id).length);
const inProgress = () => S.tasks.filter(t => t.status === 'working' || t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);

const STATUS = { queued: 'Queued', working: 'Working', review: 'Needs you', done: 'Done', failed: 'Hit a problem', stopped: 'Stopped', interrupted: 'Interrupted' };
const pill = t => `<span class="status s-${t.status}"><span class="dot" aria-hidden="true"></span>${STATUS[t.status] || t.status}</span>`;

function problemText(t) {
  if (t.status === 'failed') return t.error || 'Something went wrong.';
  if (t.status === 'interrupted') return 'HQ was closed while this was running. It can pick up where it left off.';
  return 'You stopped this one.';
}

// A finished task can go into the week's updates, once.
const filedTask = t => (S.updates.weeks || []).some(w => w.entries.some(e => e.taskId === t.id));
const updateButton = t => (filedTask(t) ? '<span class="filed">In week updates</span>' : `<button class="btn-plain" data-add-update="${t.id}">Add to week updates</button>`);

function taskActions(t, where) {
  const id = t.id;
  const onCard = where === 'card';
  const report = onCard ? `<button class="btn-plain" data-open="${id}">Read report</button>` : '';
  const sendBack = onCard ? `<button class="btn" data-open="${id}" data-sendback>Send back</button>` : '<button class="btn" data-sendback-open>Send back</button>';
  switch (t.status) {
    case 'review': {
      const withContext = `<button class="btn" data-approve-context="${id}">Approve with context</button>`;
      return t.needsOk?.length
        ? `<button class="btn btn-primary" data-act="approve" data-id="${id}">Approve</button>${withContext}${sendBack}${onCard ? report : `<button class="btn-plain" data-act="done" data-id="${id}">Done, skip those</button>`}${updateButton(t)}`
        : `<button class="btn btn-primary" data-act="done" data-id="${id}">Approve</button>${withContext}${sendBack}${report}${updateButton(t)}`;
    }
    case 'failed': case 'interrupted': case 'stopped': {
      const label = { failed: 'Try again', interrupted: 'Carry on', stopped: 'Start again' }[t.status];
      return `<button class="btn btn-primary" data-act="retry" data-id="${id}">${label}</button>${onCard ? `<button class="btn-plain" data-open="${id}">Details</button>` : ''}<button class="btn-plain destructive" data-act="discard" data-id="${id}">Discard</button>`;
    }
    case 'working': case 'queued':
      return `<button class="btn" data-act="stop" data-id="${id}">Stop</button>`;
    case 'done':
      return onCard ? '' : `<button class="btn" data-sendback-open>Reopen with a note</button>${updateButton(t)}`;
    default: return '';
  }
}

// ---------- attachments: paperclip, drag and drop, paste ----------

const isImagePath = p => /\.(png|jpe?g|gif|webp)$/i.test(p);

function attachable({ zone, input, chips, onChange }) {
  const files = [];
  const paint = () => {
    setHTML(chips, files.map(f => `<span class="attachment is-${f.status}">
      ${f.kind === 'image' && f.path ? `<img src="/api/file?path=${encodeURIComponent(f.path)}" alt="">` : FILE_GLYPH}
      <span class="attachment-name">${esc(f.name)}</span>
      ${f.status === 'uploading' ? '<span class="attachment-status">Uploading…</span>' : f.status === 'error' ? '<span class="attachment-status">Didn\'t upload</span>' : ''}
      <button type="button" class="attachment-remove" data-remove-attachment="${f.id}" aria-label="Remove ${esc(f.name)}">${CLOSE_GLYPH}</button>
    </span>`).join(''));
    chips.hidden = !files.length;
    onChange?.();
  };
  const add = async list => {
    for (const file of list) {
      const f = { id: crypto.randomUUID(), name: file.name || 'file', status: 'uploading', kind: (file.type || '').startsWith('image/') ? 'image' : 'file' };
      files.push(f);
      paint();
      try {
        const res = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, {
          method: 'POST', headers: { 'x-hq': '1', 'content-type': file.type || 'application/octet-stream' }, body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
        Object.assign(f, data, { status: 'ready' });
      } catch (ex) {
        f.status = 'error';
        toast(/not found/i.test(ex.message) ? 'Restart HQ to switch on file uploads.' : ex.message);
      }
      paint();
    }
  };
  input.addEventListener('change', () => { add([...input.files]); input.value = ''; });
  chips.addEventListener('click', e => {
    const btn = e.target.closest('[data-remove-attachment]');
    if (!btn) return;
    const i = files.findIndex(f => f.id === btn.dataset.removeAttachment);
    if (i >= 0) files.splice(i, 1);
    paint();
  });
  zone.addEventListener('dragover', e => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    zone.classList.add('is-dropping');
  });
  zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('is-dropping'); });
  zone.addEventListener('drop', e => {
    zone.classList.remove('is-dropping');
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    add([...e.dataTransfer.files]);
  });
  zone.addEventListener('paste', e => {
    const pasted = [...(e.clipboardData?.files || [])];
    if (!pasted.length) return;
    e.preventDefault();
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    add(pasted.map(f => (f.name && f.name !== 'image.png' ? f : new File([f], `screenshot-${stamp}.png`, { type: f.type || 'image/png' }))));
  });
  return {
    ready: () => files.filter(f => f.status === 'ready'),
    busy: () => files.some(f => f.status === 'uploading'),
    lines: () => files.filter(f => f.status === 'ready').map(f => `Attached: ${f.path}`).join('\n'),
    clear: () => { files.length = 0; paint(); },
  };
}

// ---------- sidebar ----------

function navItem({ href, current, icon, name, sub, live, badge }) {
  return `<a class="nav-item" href="${href}"${current ? ' aria-current="page"' : ''}>
    ${icon}
    <span class="nav-text"><span class="nav-name">${esc(name)}</span><span class="nav-sub${live ? ' is-live' : ''}">${esc(sub)}</span></span>
    ${badge ? `<span class="badge" aria-label="${badge} need you">${badge}</span>` : ''}
  </a>`;
}

function renderRail() {
  const n = needsCount();
  const managers = S.managers.map(m => {
    const live = S.live[m.id] || {};
    const working = tasksOf(m.id).filter(t => t.status === 'working').length;
    const sub = live.busy ? `${live.activity && live.activity !== 'Writing' ? live.activity : 'Replying'}…`
      : working ? `${working} worker${working > 1 ? 's' : ''} running` : 'Ready';
    return navItem({
      href: `#/m/${m.id}`, current: S.view === m.id, icon: avatar(m), name: m.name, sub,
      live: live.busy || working, badge: needsCount(m.id),
    });
  }).join('');
  const r = S.routines;
  const ranToday = S.feed.filter(e => e.kind === 'run' && e.at >= new Date().setHours(0, 0, 0, 0)).length;
  const routineSub = r.syncing ? 'Checking…' : r.lastError ? 'Last check failed' : ranToday ? `${ranToday} ran today` : `${S.upcoming.length} still to run today`;
  const me = S.owner || {};
  const initials = (me.name || 'You').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const filed = S.updates.weeks?.[0]?.entries.length || 0;
  setHTML($('#rail'), `<div class="me">${me.photo ? '<img class="me-photo" src="/me.png" alt="">' : `<span class="me-photo me-initials" aria-hidden="true">${esc(initials)}</span>`}<span class="me-text"><span class="me-name">${esc(me.name || 'You')}</span><span class="me-sub">HQ</span></span></div>${navItem({
    href: '#/', current: S.view === 'home', icon: tile('home'), name: 'Home',
    sub: n ? `${n} need${n === 1 ? 's' : ''} you` : 'All caught up', badge: n,
  })}${navItem({
    href: '#/routines', current: S.view === 'routines', icon: tile('routine'), name: 'Routines', sub: routineSub, live: r.syncing,
  })}${navItem({
    href: '#/updates', current: S.view === 'updates', icon: tile('updates'), name: 'Week Updates', sub: filed ? `${filed} this week` : 'None yet this week',
  })}<p class="nav-group">Managers</p>${managers}`);
}

// ---------- new-task composer (home and sheet) ----------

const composerHTML = (collapsible = false) => `
  <form class="composer card${collapsible ? ' is-collapsible is-collapsed' : ''}" novalidate>
    <div class="composer-top"><h2 class="composer-title">New task</h2><div class="segmented" role="radiogroup" aria-label="Manager"></div></div>
    <textarea name="brief" rows="${collapsible ? 1 : 3}" aria-label="Describe the task" placeholder="${collapsible ? 'Start a task for a manager…' : 'Describe the task. A worker takes it from here and reports back under Needs You.'}"></textarea>
    <div class="attachments" hidden></div>
    <div class="composer-foot">
      <button type="button" class="round-btn attach-btn" aria-label="Attach files" title="Attach files">${CLIP_GLYPH}</button>
      <input type="file" class="file-input" multiple hidden>
      <label class="folder-pick">Work in <select name="folder"></select></label>
      <span class="spacer"></span>
      <button class="btn btn-primary" type="submit">Start task</button>
    </div>
    <p class="form-error" role="alert"></p>
  </form>`;

function bindComposer(form, fixedId, onDone) {
  let current = fixedId || prefs.get('hq.composer', null);
  const seg = $('.segmented', form);
  const select = $('select', form);
  const textarea = $('textarea', form);
  const error = $('.form-error', form);
  const submit = $('button[type=submit]', form);
  const att = attachable({ zone: form, input: $('.file-input', form), chips: $('.attachments', form) });
  $('.attach-btn', form).addEventListener('click', () => $('.file-input', form).click());

  form._paint = () => {
    if (!mgr(current)) current = S.managers[0]?.id;
    const m = mgr(current);
    if (!m) return;
    if (fixedId) {
      $('.composer-title', form).textContent = `New task for ${m.name}`;
      seg.hidden = true;
    } else {
      setHTML(seg, S.managers.map(x => `<button type="button" class="segment" role="radio" aria-checked="${x.id === current}" data-id="${x.id}">${esc(shortName(x))}</button>`).join(''));
    }
    if (select._for !== current) {
      select.innerHTML = m.folders.map(f => `<option value="${esc(f)}">${esc(pathName(f))}</option>`).join('');
      select._for = current;
    }
  };
  form._paint();

  seg.addEventListener('click', e => {
    const btn = e.target.closest('[data-id]');
    if (!btn || fixedId) return;
    current = btn.dataset.id;
    prefs.set('hq.composer', current);
    form._paint();
    textarea.focus();
  });
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  textarea.addEventListener('input', () => { error.textContent = ''; });
  if (form.classList.contains('is-collapsible')) {
    textarea.addEventListener('focus', () => form.classList.remove('is-collapsed'));
    form.addEventListener('focusout', e => {
      if (!form.contains(e.relatedTarget) && !textarea.value.trim()) form.classList.add('is-collapsed');
    });
  }
  form.addEventListener('submit', async e => {
    e.preventDefault();
    error.textContent = '';
    if (att.busy()) { error.textContent = 'Wait for the upload to finish.'; return; }
    const brief = [textarea.value.trim(), att.lines()].filter(Boolean).join('\n\n');
    if (!textarea.value.trim()) { error.textContent = 'Describe the task first. A sentence or two is enough.'; textarea.focus(); return; }
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    submit.textContent = 'Starting…';
    try {
      const task = await api('/tasks', { method: 'POST', body: { manager: current, folder: select.value, brief } });
      textarea.value = '';
      att.clear();
      if (form.classList.contains('is-collapsible')) { form.classList.add('is-collapsed'); textarea.blur(); }
      toast(task.status === 'queued'
        ? `Task #${task.id} is queued behind another worker in ${pathName(task.folder)}.`
        : `Task #${task.id} started with ${mgr(current).name}.`);
      onDone?.(task);
    } catch (ex) {
      error.textContent = ex.message;
    } finally {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      submit.textContent = 'Start task';
    }
  });
}

// ---------- home: the dashboard ----------

function mountHome() {
  $('#main').innerHTML = `
    <div class="page narrow dashboard">
      <div class="aura" aria-hidden="true"></div>
      <header class="hello">
        <p class="date" id="today"></p>
        <h1 class="large-title" id="greeting"></h1>
        <p class="day-summary" id="day-summary"></p>
      </header>
      <div id="month-banner"></div>
      ${composerHTML(true)}
      <section class="section" id="calls" aria-label="Your calls"></section>
      <section class="section" id="review" aria-label="To review"></section>
      <section class="section" id="now" aria-label="Happening now"></section>
      <section class="section" id="projects" aria-label="Projects"></section>
      <section class="section" id="today-feed" aria-label="Today"></section>
      <section class="section" id="earlier" aria-label="Earlier this week"></section>
    </div>`;
  bindComposer($('#main form'), null);
}

const sectionHead = (title, count, extra = '') => `<div class="section-head"><h2>${title}</h2>${count ? `<span class="count">${count}</span>` : ''}${extra}</div>`;
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };

function assetHTML(a) {
  const name = esc(pathName(a.path));
  if (!a.exists) return `<p class="asset-missing">${FILE_GLYPH}${name} isn't there yet</p>`;
  if (a.kind === 'image') {
    return `<button class="asset-thumb" data-open-file="${esc(a.path)}" title="Open ${name}"><img src="/api/file?path=${encodeURIComponent(a.path)}" alt="${name}" loading="lazy"></button>`;
  }
  return `<button class="asset-chip" data-open-file="${esc(a.path)}">${FILE_GLYPH}<span>${name}</span><span class="asset-open">Open</span></button>`;
}

// The lean review card: what's ready, the copy to paste, the asset it needs, and why.
function cardBody(t) {
  const c = t.card || {};
  let html = `<p class="summary">${inline(t.summary || 'Finished. Read the report for details.')}</p>`;
  for (const post of c.posts || []) {
    html += `<div class="post"><p class="post-text">${esc(post)}</p><button class="btn-plain copy-btn" data-copy="${esc(post)}">Copy</button></div>`;
  }
  if (c.assets?.length || c.needsMaking) {
    html += `<div class="assets">${(c.assets || []).map(assetHTML).join('')}${c.needsMaking
      ? `<p class="needs-making"><span class="dot" aria-hidden="true"></span>Needs making: ${inline(c.needsMaking)}</p>` : ''}</div>`;
  }
  if (c.why) html += `<p class="why">${inline(c.why)}</p>`;
  if (t.needsOk?.length) html += `<div class="wants"><p class="wants-label">Wants your OK to</p><ul>${t.needsOk.map(a => `<li>${inline(a)}</li>`).join('')}</ul></div>`;
  return html;
}

function approveContextForm(t) {
  const hint = t.needsOk?.length ? 'It goes ahead with the actions above, following your context.' : 'The worker acts on your context, then it\'s done.';
  return `<form class="context-form" data-approve-form="${t.id}">
    <textarea class="field" name="note" rows="2" data-keep="approve-${t.id}" placeholder="Context for the go-ahead. For example: use the second option, post it Tuesday, and tag the team" aria-label="Context for ${esc(t.title)}"></textarea>
    <div class="context-foot"><span class="context-hint">${hint}</span><button class="btn-plain" type="button" data-approve-cancel>Cancel</button><button class="btn btn-primary" type="submit">Approve</button></div>
  </form>`;
}

function taskCard(t) {
  const m = mgr(t.manager);
  if (!m) return '';
  const body = t.status === 'review' ? cardBody(t) : `<p class="problem">${esc(problemText(t))}</p>`;
  return `<article class="task-card card">
    <div class="card-meta"><span class="who">${avatar(m, 'sm')}${esc(m.name)}</span><span class="spacer"></span><span>${ago(t.updatedAt)}</span></div>
    <h3><button class="title-btn" data-open="${t.id}">${esc(t.title)}</button></h3>
    ${body}
    <div class="actions">${taskActions(t, 'card')}</div>
    ${S.approvingWith === t.id ? approveContextForm(t) : ''}
  </article>`;
}

// A new manager a manager proposed: what it owns, its folders and its role, for the owner to approve or discard.
function proposalCard(p) {
  const from = mgr(p.from);
  const role = String(p.role || '').replace(/^#\s.*\n+/, '');
  const owns = role.match(/\*\*Owns:\*\*\s*(.+)/)?.[1] || p.blurb;
  return `<article class="task-card card proposal-card">
    <div class="card-meta"><span class="who">${from ? `${avatar(from, 'sm')}${esc(from.name)}` : 'HQ'}</span><span class="spacer"></span><span>${ago(p.at)}</span></div>
    <h3 class="proposal-name">${tile(p.icon, '', 250, p.name[0], p.color)}<span>New manager: ${esc(p.name)}</span></h3>
    <p class="summary">${esc(p.blurb)}</p>
    <dl class="proposal-facts">
      <dt>Owns</dt><dd>${inline(owns)}</dd>
      <dt>Folders</dt><dd>${p.folders.map(f => pathBtn(f)).join('')}</dd>
      ${p.handoff ? `<dt>First job</dt><dd>${esc(p.handoff.title)}</dd>` : ''}
    </dl>
    <div class="role-preview md" aria-label="Its role">${md(role)}</div>
    <div class="actions"><button class="btn btn-primary" data-proposal="approve" data-id="${esc(p.id)}">Approve</button><button class="btn-plain destructive" data-proposal="discard" data-id="${esc(p.id)}">Discard</button></div>
  </article>`;
}

async function proposalAction(btn) {
  const { proposal: action, id } = btn.dataset;
  const p = (S.proposals || []).find(x => x.id === id);
  if (!p) return;
  if (action === 'discard' && !confirm(`Discard ${p.name}? ${mgr(p.from)?.name || 'Its manager'} hears that you said no.`)) return;
  btn.disabled = true;
  try {
    await api(`/proposals/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
    toast(action === 'approve' ? `${p.name} is on your team. It's in the sidebar.` : 'Discarded.');
  } catch (ex) {
    toast(ex.message);
    btn.disabled = false;
  }
}

function line({ time = '', icon, name = '', text, trailing = '', attrs = '', cls = '' }) {
  const clickable = attrs ? ' is-clickable' : '';
  return `<li class="group-row feed-row${clickable}${cls ? ` ${cls}` : ''}" ${attrs}${attrs ? ' tabindex="0"' : ''}>
    ${time ? `<time class="feed-time">${time}</time>` : ''}${icon}
    <span class="feed-text">${name ? `<strong>${esc(name)}</strong><span class="sep" aria-hidden="true"> · </span>` : ''}${esc(text)}</span>${trailing}
  </li>`;
}

function verdictControl(e) {
  if (e.ok === false) return '<span class="status s-failed"><span class="dot" aria-hidden="true"></span>Failed</span>';
  if (e.verdict) {
    return `<button class="verdict is-set ${e.verdict}" data-verdict="" data-run-id="${esc(e.runId)}" title="Undo">${e.verdict === 'useful' ? 'Useful' : 'Noise'}</button>`;
  }
  return `<span class="verdicts"><button class="verdict" data-verdict="useful" data-run-id="${esc(e.runId)}">Useful</button><button class="verdict" data-verdict="noise" data-run-id="${esc(e.runId)}">Noise</button></span>`;
}

const EVENT_STATUS = { review: ['s-review', 'Needs you'], failed: ['s-failed', 'Problem'], done: ['s-done', 'Done'], discarded: ['', 'Discarded'] };

function feedLine(e) {
  if (e.kind === 'run') {
    return line({ time: clock(e.at), icon: tile('routine', 'sm'), name: e.routine, text: e.text, trailing: verdictControl(e), attrs: `data-run="${esc(e.runId)}"` });
  }
  if (e.kind === 'project') return line({ time: clock(e.at), icon: tile('project', 'sm'), name: 'Projects', text: e.text });
  const m = mgr(e.manager);
  const icon = m ? avatar(m, 'sm') : tile('home', 'sm');
  const liveTask = e.taskId && S.tasks.some(t => t.id === e.taskId);
  const attrs = liveTask ? `data-row="${e.taskId}"` : m ? `data-goto="#/m/${m.id}"` : '';
  const st = EVENT_STATUS[e.status];
  const trailing = st ? `<span class="status ${st[0]}"><span class="dot" aria-hidden="true"></span>${st[1]}</span>` : '';
  return line({ time: clock(e.at), icon, name: m?.name || '', text: e.text, trailing, attrs });
}

// ----- calls: answer in place, the manager takes it from there -----

const callKey = c => `${c.manager}|${c.raw}`;
const CHECK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="check-path" d="M4 8.4l2.6 2.6L12 5.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function openCalls() {
  if (!S.version) return deskAsks().map(a => ({ manager: a.manager.id, raw: a.text, text: a.text, kind: 'legacy', options: [] }));
  return (S.calls || []).filter(c => !S.answered.has(callKey(c)) || S.answered.get(callKey(c)).leaving !== 'gone');
}

function callRow(c) {
  const m = mgr(c.manager);
  if (!m) return '';
  const key = esc(callKey(c));
  const answered = S.answered.get(callKey(c));
  if (c.kind === 'legacy') {
    return `<li class="call" data-goto="#/m/${m.id}" tabindex="0"><span class="call-check is-static" aria-hidden="true"></span>
      <div class="call-body"><span class="call-who">${avatar(m, 'xs')}${esc(m.name)}</span><span class="call-text">${inline(c.text)}</span></div>
      <span class="chev" aria-hidden="true">›</span></li>`;
  }
  // "Reply" among the options means "let me type it", so it opens the reply box instead of being an answer.
  const options = c.kind === 'choice' ? c.options.filter(o => !/^reply$/i.test(o)) : [];
  const choices = options.map((o, i) => `<button class="chip${i === 0 ? ' is-primary' : ''}" data-answer="${esc(o)}" data-call="${key}">${esc(o)}</button>`).join('');
  const reply = `<button class="chip is-quiet" data-reply="${key}">${options.length && options.length === c.options.length ? 'Add context' : 'Reply'}</button>`;
  const replying = S.replying === callKey(c);
  return `<li class="call${answered ? ' is-done' : ''}${answered?.leaving ? ' is-leaving' : ''}">
    <button class="call-check" data-answer="Done" data-call="${key}" aria-label="Mark done: ${esc(c.text)}">${CHECK_SVG}</button>
    <div class="call-body">
      <span class="call-who">${avatar(m, 'xs')}${esc(m.name)}</span>
      <span class="call-text">${inline(c.text)}</span>
      ${replying ? `<form class="reply-form" data-reply-form="${key}"><input class="field reply-input" name="reply" data-keep="reply-${key}" placeholder="${c.kind === 'choice' ? `Add context, then pick ${c.options.map(esc).join(' or ')}. Or just type a reply` : `Your answer for ${esc(m.name)}`}" autocomplete="off" aria-label="Reply to ${esc(m.name)}"><button class="btn btn-primary" type="submit">Send</button><button class="btn-plain" type="button" data-reply-cancel>Cancel</button></form>` : ''}
    </div>
    <span class="chips">${answered ? `<span class="answered-as">${esc(answered.answer)}</span>` : `${choices}${replying ? '' : reply}`}</span>
  </li>`;
}

async function answerCall(key, answer, note = '') {
  const c = (S.calls || []).find(x => callKey(x) === key);
  if (!c) return;
  S.replying = null;
  S.answered.set(key, { answer, leaving: '' });
  renderHome();
  try {
    await api('/calls/answer', { method: 'POST', body: { manager: c.manager, raw: c.raw, answer, note } });
    toast(`Sent to ${mgr(c.manager)?.name}. It takes it from here.`);
    setTimeout(() => { const a = S.answered.get(key); if (a) { a.leaving = 'leaving'; renderHome(); } }, 650);
    setTimeout(() => { const a = S.answered.get(key); if (a) { a.leaving = 'gone'; renderHome(); } }, 1100);
  } catch (ex) {
    S.answered.delete(key);
    renderHome();
    toast(/not found/i.test(ex.message) ? 'Restart HQ to switch on answering from here.' : ex.message);
  }
}

// ----- projects: one line each, from ~/HQ/PROJECTS.md -----

const laneLabel = lane => ({ 'Strategy and campaigns': 'Strategy', Website: 'Web', 'Outbound and pipeline': 'Outbound', 'Partner content and comms': 'Content' }[lane] || lane.split(' ')[0]);

function projectRow(p) {
  const leaving = S.projectDone.has(p.num);
  const line1 = p.next || p.about || p.statusNote || '';
  const triage = p.status === 'unclear'
    ? `<span class="chips"><button class="chip" data-project="${p.num}" data-status="moving">Moving</button><button class="chip" data-project="${p.num}" data-status="parked">Parked</button><button class="chip" data-project="${p.num}" data-status="done">Done</button></span>`
    : `<span class="project-lane">${esc(laneLabel(p.lane))}</span>`;
  return `<li class="project s-${p.status}${leaving ? ' is-done' : ''}">
    <button class="project-check" data-project="${p.num}" data-status="done" aria-label="Mark ${esc(p.name)} done"><span class="project-dot" aria-hidden="true"></span>${CHECK_SVG}</button>
    <span class="project-text"><strong>${esc(p.name)}</strong>${line1 ? `<span class="sep" aria-hidden="true"> · </span>${inline(line1)}` : ''}</span>
    ${triage}
  </li>`;
}

async function setProject(num, status) {
  const p = (S.projects || []).find(x => x.num === num);
  if (!p) return;
  if (status === 'done') { S.projectDone.add(num); renderHome(); }
  try {
    await api(`/projects/${num}/status`, { method: 'POST', body: { status } });
    toastUndo(`${p.name}: ${status === 'done' ? 'done' : `marked ${status}`}.`, () => setProject(num, p.status));
  } catch (ex) {
    toast(/not found/i.test(ex.message) && !S.version ? 'Restart HQ to switch on ticking projects off.' : ex.message);
  } finally {
    setTimeout(() => { S.projectDone.delete(num); renderHome(); }, 900);
  }
}

function renderHome() {
  if (!$('#greeting')) return;
  const calls = openCalls();
  const review = needsYou();
  const proposals = S.proposals || [];
  $('#today').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  setHTML($('#greeting'), S.owner?.name ? `${greeting()}, ${esc(S.owner.name)}.` : `${greeting()}.`);
  setHTML($('#day-summary'), esc(S.summary || (calls.length + review.length
    ? `${calls.length + review.length} things need you.`
    : 'Nothing needs you right now.')));
  $('#main form')?._paint?.();

  const month = S.month;
  setHTML($('#month-banner'), month.closable ? `<div class="banner card">
      <div><strong>Time to close ${esc(month.closableLabel)}.</strong> You'll get a review of what shipped and which routines earned their place.</div>
      <button class="btn btn-primary" data-close-month="${esc(month.closable)}">Close ${esc(month.closableLabel.split(' ')[0])}</button>
    </div>` : '');

  if (!S.managers.length) {
    setHTML($('#calls'), `<div class="banner card setup-card">
      <div><strong>Welcome to HQ.</strong> Set it up in a few minutes: open Claude Code in your HQ folder and say <em>set up HQ</em>. It asks who you are and which managers you want, then writes everything for you.</div>
    </div>`);
  }
  const waiting = calls.filter(c => !S.answered.has(callKey(c))).length;
  if (S.managers.length) {
    setHTML($('#calls'), calls.length ? `${sectionHead('Your Calls', '', `<span class="count">${waiting ? `${waiting} left` : 'All done'}</span>`)}
      <ul class="calls card">${calls.map(callRow).join('')}</ul>` : '');
  }

  setHTML($('#review'), review.length || proposals.length ? `${sectionHead('To Review', review.length + proposals.length)}<div class="stack">${proposals.map(proposalCard).join('')}${review.map(taskCard).join('')}</div>` : '');

  const busy = S.managers.filter(m => (S.live[m.id] || {}).busy);
  const working = inProgress();
  setHTML($('#now'), busy.length || working.length ? `${sectionHead('Now')}<ul class="group has-icons">
    ${busy.map(m => line({
      icon: avatar(m, 'sm'), name: m.name, text: `${(S.live[m.id].activity && S.live[m.id].activity !== 'Writing') ? S.live[m.id].activity : 'Replying'}…`,
      attrs: `data-goto="#/m/${m.id}"`, trailing: '<span class="live-dot" aria-hidden="true"></span>',
    })).join('')}
    ${working.map(t => line({
      icon: avatar(mgr(t.manager), 'sm'), name: mgr(t.manager)?.name, text: t.status === 'working' ? `${t.title}: ${t.activity || 'working'} · ${elapsed(t.startedAt)}` : `${t.title}: queued`,
      attrs: `data-row="${t.id}"`, trailing: `<button class="btn-plain" data-act="stop" data-id="${t.id}">Stop</button>`,
    })).join('')}
  </ul>` : '');

  const projects = S.projects || [];
  const active = projects.filter(p => p.status !== 'unclear').sort((a, b) => (a.status === b.status ? a.num - b.num : a.status === 'waiting' ? -1 : 1));
  const unclear = projects.filter(p => p.status === 'unclear');
  const moving = projects.filter(p => p.status === 'moving').length;
  const stalled = projects.filter(p => p.status === 'waiting').length;
  setHTML($('#projects'), projects.length ? `${sectionHead('Projects', '', `<span class="count">${moving} moving${stalled ? ` · ${stalled} waiting` : ''}</span>`)}
    <ul class="projects card">${active.map(projectRow).join('')}</ul>
    ${unclear.length ? `<details class="disclosure unclear-fold" id="unclear-fold"${S.unclearOpen ? ' open' : ''}><summary>${unclear.length} with no clear status. Sort them in a tap</summary><ul class="projects card">${unclear.map(projectRow).join('')}</ul></details>` : ''}` : '');

  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const today = S.feed.filter(e => e.at >= startOfDay);
  const upcoming = S.upcoming.map(u => line({
    time: clock(u.at), icon: tile('routine', 'sm'), name: u.routine, text: u.where === 'mac' ? 'scheduled on your Mac' : 'scheduled', cls: 'is-upcoming',
  }));
  setHTML($('#today-feed'), `${sectionHead('Today')}${today.length || upcoming.length
    ? `<ul class="group has-icons feed">${upcoming.join('')}${today.map(feedLine).join('')}</ul>`
    : '<div class="empty">Nothing yet today. Managers, workers and scheduled runs each add a line here.</div>'}`);

  const earlier = S.feed.filter(e => e.at < startOfDay);
  const days = [];
  for (const e of earlier) {
    const label = new Date(e.at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    if (days.at(-1)?.label !== label) days.push({ label, events: [] });
    days.at(-1).events.push(e);
  }
  setHTML($('#earlier'), days.length ? `<details class="disclosure" id="earlier-fold"${S.earlierOpen ? ' open' : ''}>
      <summary class="section-head"><h2>Earlier This Week</h2><span class="count">${earlier.length}</span></summary>
      ${days.map(d => `<p class="day-label">${esc(d.label)}</p><ul class="group has-icons feed">${d.events.map(feedLine).join('')}</ul>`).join('')}
    </details>` : '');
}

// ---------- routines ----------

function mountRoutines() {
  $('#main').innerHTML = `
    <div class="page narrow dashboard">
      <p class="date" id="routines-sub"></p>
      <h1 class="large-title">Routines</h1>
      <section class="section" id="scorecard" aria-label="This month"></section>
      <section class="section" id="recent-runs" aria-label="Recent runs"></section>
      <section class="section" id="reviews" aria-label="Monthly reviews"></section>
    </div>`;
}

const HINT_CLASS = { Keep: 's-done', 'Looks like noise: pause or merge': 's-failed', 'Rarely opened: pause or merge': 's-failed' };

function renderRoutines() {
  const r = S.routines;
  const checked = r.lastSyncAt ? `Checked ${ago(r.lastSyncAt)}` : 'Not checked yet';
  setHTML($('#routines-sub'), `${r.syncing ? 'Checking your routines…' : esc(checked)}${r.syncing ? '' : ' · <button class="btn-plain inline" data-sync>Check now</button>'}${r.lastError
    ? `<span class="sync-error">Last check failed: ${esc(r.lastError.slice(0, 160))}</span>` : ''}`);

  const rows = r.list.map(x => `<li class="group-row">
      ${tile('routine', 'sm')}
      <div class="row-main">
        <div class="row-title">${esc(x.name)}</div>
        <div class="row-sub"><span>${esc(x.schedule)}${x.where === 'mac' ? ' on your Mac' : ''}${x.next ? ` · next ${esc(new Date(x.next).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}` : ''}</span></div>
        ${x.tracked ? `<div class="row-sub stats num"><span>${x.runs} runs · ${x.opened} opened · ${x.replied} replied · ${x.useful} useful · ${x.noise} noise${x.failed ? ` · ${x.failed} failed` : ''}</span></div>` : ''}
      </div>
      <span class="status ${HINT_CLASS[x.hint] || ''}"><span class="dot" aria-hidden="true"></span>${esc(x.hint)}</span>
    </li>`).join('');
  setHTML($('#scorecard'), !r.list.length ? `${sectionHead(esc(S.month.label || 'This month'))}<div class="empty">No routines yet. If you run scheduled routines on claude.ai, open Claude Code in your HQ folder and say <em>add my routines to HQ</em>.</div>` : `${sectionHead(esc(S.month.label || 'This month'))}<ul class="group has-icons">${rows}</ul>
    <p class="footnote">Opened means you opened the run here. Replied means you answered it in Claude after it ran. Mark each run Useful or Noise from the feed; after a month, the suggestions get reliable.</p>`);

  const runs = S.feed.filter(e => e.kind === 'run');
  setHTML($('#recent-runs'), `${sectionHead('Recent Runs', runs.length)}${runs.length
    ? `<ul class="group has-icons feed">${runs.map(e => line({
      time: new Date(e.at).toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + clock(e.at), icon: tile('routine', 'sm'), name: e.routine, text: e.text,
      trailing: verdictControl(e), attrs: `data-run="${esc(e.runId)}"`,
    })).join('')}</ul>`
    : '<div class="empty">No runs collected yet. HQ checks after each routine is due, or use Check now.</div>'}`);

  const month = S.month;
  setHTML($('#reviews'), `${sectionHead('Monthly Reviews')}
    <ul class="group">
      <li class="group-row"><div class="row-main"><div class="row-title">${esc(month.label || '')}</div><div class="row-sub"><span>${month.closable === month.current ? 'Ready to close' : 'In progress'}</span></div></div>
        <button class="btn${month.closable === month.current ? ' btn-primary' : ''}" data-close-month="${esc(month.current || '')}">Close the month</button></li>
      ${(month.closed || []).map(c => `<li class="group-row is-clickable" data-review="${esc(c.key)}" tabindex="0"><div class="row-main"><div class="row-title">${esc(c.label)} review</div></div><span class="chev" aria-hidden="true">›</span></li>`).join('')}
    </ul>`);
}

// ---------- week updates ----------

function mountUpdates() {
  $('#main').innerHTML = `
    <div class="page narrow dashboard">
      <p class="date" id="updates-sub"></p>
      <h1 class="large-title">Week Updates</h1>
      <div class="updates-bar" id="updates-bar"></div>
      <section class="section" id="updates-list" aria-label="This week's entries"></section>
    </div>`;
}

const shownWeek = () => S.updates.weeks?.[S.updatesWeek] || S.updates.weeks?.[0];
const findUpdate = id => (S.updates.weeks || []).flatMap(w => w.entries).find(e => e.id === id);

function updateLinks(e) {
  return (e.links || []).map(l => {
    if (isPath(l)) return pathBtn(l);
    const url = httpsOnly(l);
    if (!url) return '';
    let label = url;
    try { const u = new URL(url); label = `${u.hostname.replace(/^www\./, '')}${u.pathname.length > 1 ? u.pathname : ''}`; } catch {}
    return `<a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(url)}">${esc(label.length > 48 ? `${label.slice(0, 47)}…` : label)}</a>`;
  }).join('');
}

function renderUpdates() {
  const week = shownWeek();
  if (!$('#updates-list') || !week) return;
  const router = S.managers.find(m => m.router);
  const empty = !week.entries.length;
  setHTML($('#updates-sub'), esc(week.label));
  setHTML($('#updates-bar'), `<div class="segmented" role="radiogroup" aria-label="Week">${S.updates.weeks.map((w, i) => `<button type="button" class="segment" role="radio" aria-checked="${i === S.updatesWeek}" data-week="${i}">${i ? 'Last week' : 'This week'}</button>`).join('')}</div>
    <span class="spacer"></span>
    <button class="btn" data-copy="${esc(week.markdown)}"${empty ? ' disabled' : ''}>Copy as update</button>
    ${router ? `<button class="btn btn-primary" data-draft-update${empty ? ' disabled' : ''}>${S.updates.for ? `Draft update for ${esc(S.updates.for)}` : `Ask ${esc(router.name)} to draft`}</button>` : ''}`);
  if (empty) {
    setHTML($('#updates-list'), `<div class="empty">Nothing filed ${S.updatesWeek ? 'last' : 'this'} week${S.updatesWeek ? '' : ' yet'}. Tell any manager <strong>“send it to week updates”</strong> when something's done, or use <strong>Add to week updates</strong> on a finished task.</div>`);
    return;
  }
  const groups = [];
  for (const e of week.entries) {
    let g = groups.find(x => x.manager === e.manager);
    if (!g) groups.push(g = { manager: e.manager, entries: [] });
    g.entries.push(e);
  }
  setHTML($('#updates-list'), groups.map(g => {
    const m = mgr(g.manager);
    return `<div class="update-group">
      <p class="update-who">${m ? avatar(m, 'sm') : ''}${esc(m?.name || g.manager)}</p>
      <ul class="group">${g.entries.map(e => `<li class="group-row update-row">
        <div class="row-main">
          <div class="update-title">${esc(e.title)}</div>
          ${e.summary ? `<p class="update-summary">${inline(e.summary)}</p>` : ''}
          ${e.links?.length ? `<div class="update-links">${updateLinks(e)}</div>` : ''}
        </div>
        <span class="update-actions"><button class="btn-plain" data-update-edit="${esc(e.id)}">Edit</button><button class="btn-plain destructive" data-update-delete="${esc(e.id)}">Delete</button></span>
      </li>`).join('')}</ul>
    </div>`;
  }).join(''));
}

// Add a finished task to the week's updates, or edit an entry. Prefilled from the task's title and summary.
function openUpdateForm({ entry = null, task = null }) {
  const dialog = $('#task-modal');
  dialog.innerHTML = `<form class="composer update-form" novalidate>
    <div class="composer-top"><h2 class="composer-title">${entry ? 'Edit week update' : 'Add to week updates'}</h2></div>
    <input class="field" name="title" maxlength="120" aria-label="Title" placeholder="The outcome, in a few words" autocomplete="off">
    <textarea name="summary" rows="3" aria-label="Summary" placeholder="One line that leads with the outcome. At most two more lines of detail."></textarea>
    <textarea name="links" class="links" rows="2" aria-label="Links" placeholder="Links or file paths, one per line (optional)"></textarea>
    <p class="form-error" role="alert"></p>
    <div class="composer-foot"><span class="spacer"></span><button class="btn-plain" type="button" data-update-cancel>Cancel</button><button class="btn btn-primary" type="submit">${entry ? 'Save' : 'Add'}</button></div>
  </form>`;
  const form = $('form', dialog);
  const f = form.elements;
  f.title.value = entry?.title || task?.title || '';
  f.summary.value = entry?.summary || task?.summary || '';
  f.links.value = (entry ? entry.links : (task?.card?.assets || []).filter(a => a.exists).map(a => a.path)).join('\n');
  $('[data-update-cancel]', form).addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('[type=submit]', form);
    btn.disabled = true;
    const body = { title: f.title.value, summary: f.summary.value, links: f.links.value.split('\n').map(l => l.trim()).filter(Boolean) };
    try {
      if (entry) await api(`/updates/${encodeURIComponent(entry.id)}`, { method: 'PUT', body });
      else await api('/updates', { method: 'POST', body: { ...body, manager: task?.manager, task: task?.id } });
      dialog.close();
      toast(entry ? 'Saved.' : 'Added to this week\'s updates.');
    } catch (ex) {
      $('.form-error', form).textContent = /not found/i.test(ex.message) && !entry ? 'Restart HQ to switch on week updates.' : ex.message;
      btn.disabled = false;
    }
  });
  dialog.showModal();
  f.title.focus();
}

async function deleteUpdate(id) {
  const e = findUpdate(id);
  if (!e || !confirm(`Delete "${e.title}" from the week's updates?`)) return;
  try { await api(`/updates/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('Deleted.'); } catch (ex) { toast(ex.message); }
}

// The router (General) writes the polished version from the week's file, in its own chat.
async function draftUpdate() {
  const week = shownWeek();
  const router = S.managers.find(m => m.router);
  if (!week || !router) return;
  const text = `Draft my weekly update${S.updates.for ? ` for ${S.updates.for}` : ''} from ${week.path} (the week of ${week.label}). Short and polished, ready to paste: grouped by area, outcome first, numbers only if they're real, no internal jargon.`;
  try {
    await api(`/managers/${router.id}/message`, { method: 'POST', body: { text } });
    location.hash = `#/m/${router.id}`;
  } catch (ex) { toast(ex.message); }
}

// ---------- manager ----------

function mountManager(id) {
  const m = mgr(id);
  $('#main').innerHTML = `
    <div class="mgr">
      <div class="mgr-main">
        <header class="mgr-head">
          ${avatar(m, 'lg')}
          <div class="mgr-head-text"><h1>${esc(m.name)}</h1><div class="mgr-sub" id="mgr-sub"></div></div>
          <div class="mgr-controls" id="mgr-controls"></div>
          <div class="mgr-head-actions">
            <button class="btn only-narrow" id="desk-toggle" aria-expanded="false" aria-controls="mgr-side">Desk</button>
            <button class="btn" id="new-task-btn">New task</button>
          </div>
        </header>
        <div class="thread" id="thread"><div class="thread-inner"><div id="history" style="display:contents"></div><div id="live"></div></div></div>
        <form class="chat-composer" id="chat-form">
          <div class="fresh-bar" id="fresh-bar" hidden>
            <span id="fresh-text"></span>
            <button type="button" class="btn" data-fresh="${m.id}">Fresh start now</button>
          </div>
          <div class="attachments" id="chat-attachments" hidden></div>
          <div class="chat-box">
            <button type="button" class="round-btn attach-btn" id="chat-attach" aria-label="Attach files" title="Attach files, or drop them here">${CLIP_GLYPH}</button>
            <input type="file" id="chat-file" multiple hidden>
            <textarea id="chat-input" rows="1" aria-label="Message ${esc(m.name)}" placeholder="Message ${esc(m.name)}"></textarea>
            <button type="button" class="round-btn stop-btn" id="chat-stop" aria-label="Stop the reply" title="Stop" hidden>${STOP_GLYPH}</button>
            <button type="submit" class="round-btn send-btn" id="chat-send" aria-label="Send" title="Send" disabled>${SEND_GLYPH}</button>
          </div>
        </form>
      </div>
      <aside class="inspector" id="mgr-side" aria-label="Desk and tasks">
        <section class="inspector-section">
          <div class="inspector-head"><h2>Desk</h2><span><button class="btn-plain" id="desk-edit">Edit</button><button class="btn-plain only-narrow" id="desk-close">Close</button></span></div>
          <div id="desk-body"></div>
        </section>
        <section class="inspector-section">
          <div class="inspector-head"><h2>Tasks</h2></div>
          <div id="mgr-tasks"></div>
        </section>
      </aside>
    </div>`;

  const input = $('#chat-input');
  const sendBtn = $('#chat-send');
  let att = null;
  const sync = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
    sendBtn.disabled = !input.value.trim() && !(att?.ready().length);
  };
  att = attachable({ zone: $('.mgr-main'), input: $('#chat-file'), chips: $('#chat-attachments'), onChange: sync });
  $('#chat-attach').addEventListener('click', () => $('#chat-file').click());
  const send = async text => {
    text = text.trim();
    if (!text) return;
    S.live[id] = { busy: true, activity: 'Thinking' };
    renderLive();
    try {
      await api(`/managers/${id}/message`, { method: 'POST', body: { text } });
    } catch (ex) {
      input.value = text;
      sync();
      toast(ex.message);
    }
  };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form').requestSubmit(); }
  });
  $('#chat-form').addEventListener('submit', e => {
    e.preventDefault();
    if (att.busy()) { toast('Wait for the upload to finish.'); return; }
    const text = [input.value.trim(), att.lines()].filter(Boolean).join('\n\n');
    if (!text) return;
    input.value = '';
    att.clear();
    sync();
    send(text);
  });
  $('#history').addEventListener('click', e => {
    const starter = e.target.closest('[data-starter]');
    if (starter) send(starter.dataset.starter);
    // A tap on an answer under the manager's last message sends it as your reply.
    const option = e.target.closest('[data-chat-option]');
    if (option) { S.chipsSent[id] = option.dataset.msg; renderHistory(); send(option.dataset.chatOption); }
  });
  $('#chat-stop').addEventListener('click', () => api(`/managers/${id}/stop`, { method: 'POST' }).catch(ex => toast(ex.message)));

  const side = $('#mgr-side');
  const setSide = open => { side.classList.toggle('is-open', open); $('#desk-toggle').setAttribute('aria-expanded', String(open)); };
  $('#desk-toggle').addEventListener('click', () => setSide(!side.classList.contains('is-open')));
  $('#desk-close').addEventListener('click', () => setSide(false));
  side.addEventListener('keydown', e => { if (e.key === 'Escape') setSide(false); });

  $('#desk-edit').addEventListener('click', () => editDesk(id));
  $('#new-task-btn').addEventListener('click', () => openTaskModal(id));

  input.focus();
  renderHistory();
  loadChat(id);
}

async function loadChat(id) {
  try {
    const data = await api(`/managers/${id}/chat`);
    S.chats[id] = data.messages;
    S.partial[id] = data.partial;
    S.live[id] = { busy: data.busy, activity: data.activity };
    if (S.view === id) { renderHistory(true); renderLive(); }
  } catch (ex) { toast(ex.message); }
}

function youMessage(text) {
  const files = [];
  const rest = String(text).split('\n').filter(l => {
    const m = l.match(/^Attached: (.+)$/);
    if (m) files.push(m[1].trim());
    return !m;
  }).join('\n').trim();
  const att = files.map(p => (isImagePath(p)
    ? `<button class="bubble-image" data-open-file="${esc(p)}" title="Open ${esc(pathName(p))}"><img src="/api/file?path=${encodeURIComponent(p)}" alt="${esc(pathName(p))}"></button>`
    : `<button class="bubble-file" data-path="${esc(p)}" title="Show in Finder">${FILE_GLYPH}<span>${esc(pathName(p))}</span></button>`)).join('');
  return `<div class="msg-you">${esc(rest)}${att ? `<div class="bubble-files">${att}</div>` : ''}</div>`;
}

function emptyThread(m) {
  return `<div class="thread-empty">
    ${avatar(m, 'xl')}
    <h2>${esc(m.name)}</h2>
    <p>${m.router
    ? 'Ask anything. It answers and does quick things itself. For bigger work it asks who should take it: the right manager, an open task, a new manager, or itself.'
    : 'One conversation that never resets. It keeps its desk up to date, so you can pick up anywhere. Bigger jobs go to workers and come back under Needs You.'}</p>
    <div class="starters">${(m.starters || []).map(s => `<button class="starter" data-starter="${esc(s)}">${esc(s)}</button>`).join('')}</div>
  </div>`;
}

function renderHistory(forceBottom) {
  const id = S.view;
  const m = mgr(id);
  const thread = $('#thread');
  if (!m || !thread) return;
  const messages = S.chats[id];
  if (!messages) { setHTML($('#history'), '<p class="live-line">Loading the conversation…</p>'); return; }
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
  if (!messages.length && !(S.live[id] || {}).busy) { setHTML($('#history'), emptyThread(m)); return; }

  let html = '';
  let steps = [];
  let lastAt = 0;
  // Answers in brackets at the end of the manager's last message become chips, until you reply.
  const last = messages.findLastIndex(x => x.role === 'manager');
  const replied = last < 0 || messages.slice(last + 1).some(x => x.role === 'you') || S.chipsSent[id] === messages[last].id;
  const chips = replied ? [] : replyOptions(messages[last].text);
  const flushSteps = () => {
    if (!steps.length) return;
    const key = steps[0].id;
    const label = steps.length === 1 ? esc(steps[0].text) : `${steps.length} steps · ${esc(steps.at(-1).text)}`;
    html += `<details class="steps disclosure" data-key="${key}"${S.openSteps.has(key) ? ' open' : ''}><summary>${label}</summary>${steps.length > 1 ? `<ol>${steps.map(s => `<li>${esc(s.text)}</li>`).join('')}</ol>` : ''}</details>`;
    steps = [];
  };
  for (const [i, msg] of messages.entries()) {
    if (msg.role === 'activity') { steps.push(msg); continue; }
    flushSteps();
    if (msg.at - lastAt > 3 * 3600e3) html += `<p class="msg-time">${dayTime(msg.at)}</p>`;
    lastAt = msg.at;
    if (msg.role === 'you') html += youMessage(msg.text);
    else if (msg.role === 'manager') {
      html += `<div class="msg-mgr md">${mdCached(msg.id, msg.text)}</div>`;
      if (i === last && chips.length) html += `<div class="reply-chips">${chips.map((o, n) => `<button class="chip${n === 0 ? ' is-primary' : ''}" data-chat-option="${esc(o)}" data-msg="${esc(msg.id)}">${esc(o)}</button>`).join('')}</div>`;
    } else if (msg.role === 'handoff') html += handoffMessage(msg);
    else if (msg.role === 'note') html += `<p class="msg-note">${esc(msg.text)}</p>`;
    else if (msg.role === 'error') html += `<div class="msg-error">${esc(msg.text)}</div>`;
    else if (msg.role === 'divider') html += `<p class="msg-divider">${esc(msg.text)}</p>`;
  }
  flushSteps();
  setHTML($('#history'), html);
  if (forceBottom || nearBottom) thread.scrollTop = thread.scrollHeight;
}

// The last line of a reply can end in its answers, like a desk call: "Who should take it? [Web Designer / You do it]".
// A small copy of parseCall in lib/dashboard.js: only explicit brackets count, never a guess.
function replyOptions(text) {
  const lastLine = String(text || '').trim().split('\n').pop().trim();
  const tag = lastLine.match(/\[([^[\]]+)\][\s*_`.]*$/);
  if (!tag) return [];
  const options = tag[1].split('/').map(o => o.trim()).filter(Boolean).slice(0, 4);
  if (options.length === 1 && /^(reply|x|\d+)$/i.test(options[0])) return [];
  return options;
}

// Work handed over from another manager: who from, the title, and the brief folded away.
function handoffMessage(msg) {
  const from = mgr(msg.from);
  return `<div class="msg-handoff" style="--handoff:${esc(from?.color || 'var(--accent)')}">
    <div class="handoff-head">${from ? avatar(from, 'xs') : ''}<span>Handed over from ${esc(msg.fromName || from?.name || 'another manager')}</span></div>
    <p class="handoff-title">${esc(msg.title || 'New work')}</p>
    <details class="disclosure handoff-brief" data-key="${esc(msg.id)}"${S.openSteps.has(msg.id) ? ' open' : ''}><summary>Brief</summary><div class="md">${mdCached(msg.id, msg.text)}</div></details>
  </div>`;
}

function renderLive() {
  const id = S.view;
  const live = S.live[id] || {};
  const thread = $('#thread');
  if (!thread || !mgr(id)) return;
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
  const partial = S.partial[id];
  let html = '';
  if (live.busy) {
    html = partial
      ? `<div class="msg-mgr md caret">${md(partial)}</div>`
      : `<p class="live-line"><span class="live-dot" aria-hidden="true"></span>${esc(live.activity && live.activity !== 'Writing' ? live.activity : 'Thinking')}…</p>`;
  }
  setHTML($('#live'), html);
  $('#chat-stop').hidden = !live.busy;
  const m = mgr(id);
  $('#fresh-bar').hidden = !m.long || !!live.busy;
  if (m.long) {
    $('#fresh-text').textContent = m.context
      ? `This conversation is at ${Math.round(m.context / 1000)}k tokens, and every step of a reply re-reads all of it. HQ starts fresh on its own past ${Math.round((m.autoFresh || 80000) / 1000)}k; the desk carries everything over.`
      : 'This conversation is getting long, which slows replies and uses more of your plan. The desk carries everything over.';
  }
  if (nearBottom) thread.scrollTop = thread.scrollHeight;
}

const MODEL_OPTIONS = [['', 'Default model'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const EFFORT_OPTIONS = [['', 'Default effort'], ['low', 'Low effort'], ['medium', 'Medium effort'], ['high', 'High effort'], ['max', 'Max effort']];
const options = (list, value) => list.map(([v, label]) => `<option value="${v}"${v === (value || '') ? ' selected' : ''}>${label}</option>`).join('');

function controlsHTML(m) {
  const k = Math.round((m.context || 0) / 1000);
  const limit = Math.round((m.autoFresh || 80000) / 1000);
  const level = !m.context ? 'is-new' : m.context > (m.autoFresh || 80000) * 0.75 ? 'is-high' : 'is-ok';
  return `<span class="context-chip ${level}" title="How much this conversation re-reads on every step of a reply. Past ${limit}k, HQ starts fresh on its own.">${m.context ? `${k}k context` : 'Fresh conversation'}</span>
    <select class="pill-select" data-setting="model" data-manager="${m.id}" aria-label="Model for ${esc(m.name)} and its workers">${options(MODEL_OPTIONS, m.model)}</select>
    <select class="pill-select" data-setting="effort" data-manager="${m.id}" aria-label="Effort for ${esc(m.name)} and its workers">${options(EFFORT_OPTIONS, m.effort)}</select>
    <select class="pill-select" data-setting="connectors" data-manager="${m.id}" aria-label="Connectors for ${esc(m.name)} and its workers" title="Connectors like Slack and Notion add about 12k tokens to every step. Turn them off for managers that don't use them.">${options([['on', 'Connectors on'], ['off', 'Connectors off']], m.connectors === false ? 'off' : 'on')}</select>`;
}

function renderManager() {
  const m = mgr(S.view);
  if (!m || !$('#mgr-sub')) return;
  setHTML($('#mgr-controls'), controlsHTML(m));
  const where = m.router ? `${pathBtn(m.home)}<span>and every manager's folders</span>` : m.folders.map(f => pathBtn(f)).join('<span aria-hidden="true">·</span>');
  setHTML($('#mgr-sub'), `<span>${esc(m.blurb)}</span><span aria-hidden="true">·</span>${where}`);
  if (!S.deskEditing) {
    const desk = md(deskForDisplay(m.desk.text));
    setHTML($('#desk-body'), desk ? `<div class="md desk-md">${desk}</div>` : '<p class="inspector-note">The desk is empty.</p>');
  }

  const tasks = tasksOf(m.id);
  const active = tasks.filter(t => t.status !== 'done').sort((a, b) => b.updatedAt - a.updatedAt);
  const done = tasks.filter(t => t.status === 'done').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 8);
  const row = t => `<li class="group-row is-clickable" data-row="${t.id}" tabindex="0"><div class="row-main"><div class="row-title">${esc(t.title)}</div><div class="row-sub">${pill(t)}<span>· ${ago(t.updatedAt)}</span></div></div></li>`;
  setHTML($('#mgr-tasks'), active.length || done.length
    ? `<ul class="group">${[...active, ...done].map(row).join('')}</ul>`
    : `<p class="inspector-note">No tasks yet. Ask ${esc(m.name)} to take something on, or use New task.</p>`);
  renderLive();
}

async function editDesk(id) {
  if (S.deskEditing) return;
  try {
    const { text } = await api(`/managers/${id}/desk`);
    S.deskEditing = true;
    $('#desk-edit').hidden = true;
    setHTML($('#desk-body'), `<textarea class="field desk-editor" id="desk-editor" aria-label="Desk"></textarea>
      <div class="inspector-actions"><button class="btn-plain" id="desk-cancel">Cancel</button><button class="btn btn-primary" id="desk-save">Save</button></div>`);
    const editor = $('#desk-editor');
    editor.value = text;
    editor.focus();
    const close = () => { S.deskEditing = false; $('#desk-edit').hidden = false; $('#desk-body')._html = null; renderManager(); };
    $('#desk-cancel').addEventListener('click', close);
    $('#desk-save').addEventListener('click', async () => {
      try {
        await api(`/managers/${id}/desk`, { method: 'PUT', body: { text: editor.value } });
        close();
        toast('Desk saved. The manager sees it with your next message.');
      } catch (ex) { toast(ex.message); }
    });
  } catch (ex) { toast(ex.message); }
}

function openTaskModal(id) {
  const dialog = $('#task-modal');
  dialog.innerHTML = composerHTML();
  const form = $('form', dialog);
  bindComposer(form, id, () => dialog.close());
  dialog.showModal();
  $('textarea', form).focus();
}

// ---------- task sheet ----------

function openTask(id, focusSendBack = false) {
  S.openTask = id;
  S.openRun = null;
  S.taskLog = { id, entries: [], fetchedFor: 0 };
  const dialog = $('#drawer');
  dialog.innerHTML = `<div class="drawer-inner">
    <div id="d-head"></div>
    <div class="actions" id="d-actions"></div>
    <div id="d-approve"></div>
    <div class="drawer-section" id="d-sendback" hidden>
      <h3 class="drawer-section-title">Send back with a note</h3>
      <textarea class="field" id="sendback-note" placeholder="What should change? The worker picks up where it left off."></textarea>
      <div class="actions"><button class="btn btn-primary" id="sendback-go">Send back</button><button class="btn-plain" id="sendback-cancel">Cancel</button></div>
    </div>
    <div id="d-body"></div>
    <details class="disclosure drawer-section"><summary><h3 class="drawer-section-title">Brief</h3></summary><div class="md" id="d-brief"></div></details>
    <details class="disclosure drawer-section"><summary><h3 class="drawer-section-title">Step by step</h3></summary><ol class="log" id="d-log"></ol></details>
  </div>`;
  $('#sendback-cancel').addEventListener('click', () => { $('#d-sendback').hidden = true; });
  $('#sendback-go').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api(`/tasks/${id}/send-back`, { method: 'POST', body: { note: $('#sendback-note').value } });
      $('#sendback-note').value = '';
      $('#d-sendback').hidden = true;
      toast('Sent back with your note. The worker is on it.');
    } catch (ex) { toast(ex.message); } finally { btn.disabled = false; }
  });
  if (!dialog.open) dialog.showModal();
  renderDrawer();
  if (focusSendBack) showSendBack();
}

function showSendBack() {
  $('#d-sendback').hidden = false;
  $('#sendback-note').focus();
}

function renderDrawer() {
  const dialog = $('#drawer');
  const t = S.tasks.find(x => x.id === S.openTask);
  if (!dialog.open || !t || !$('#d-head')) return;
  const m = mgr(t.manager);
  const dot = '<span aria-hidden="true">·</span>';
  setHTML($('#d-head'), `
    <div class="drawer-top"><span class="who">${avatar(m, 'sm')}${esc(m.name)}</span><span class="spacer"></span><button class="close-btn" data-close-drawer aria-label="Close">${CLOSE_GLYPH}</button></div>
    <h2 id="drawer-title">${esc(t.title)}</h2>
    <p class="drawer-meta">${pill(t)}${dot}<span class="num">#${t.id}</span>${dot}${pathBtn(t.folder)}${dot}<span>Started ${ago(t.createdAt)} by ${t.from === 'manager' ? esc(m.name) : 'you'}</span>${t.runs > 1 ? `${dot}<span>${t.runs} rounds</span>` : ''}${t.usage ? `${dot}<span title="Tokens across every step of this task">${t.usage.steps} steps, ${fmtK(t.usage.cached + t.usage.fresh)} read${t.usage.cost ? `, about $${t.usage.cost.toFixed(2)} at API prices` : ''}</span>` : ''}</p>`);
  setHTML($('#d-actions'), taskActions(t, 'drawer'));
  setHTML($('#d-approve'), S.approvingWith === t.id && t.status === 'review' ? approveContextForm(t) : '');

  let body = '';
  if (t.status === 'working') body += `<div class="drawer-section"><p class="live-line"><span class="live-dot" aria-hidden="true"></span>${esc(t.activity || 'Working')} · ${elapsed(t.startedAt)}</p></div>`;
  if (t.status === 'queued') body += '<div class="drawer-section"><p class="live-line">Queued. It starts when the worker already busy in this folder finishes.</p></div>';
  if (t.status === 'review') body += `<div class="drawer-section lean">${cardBody(t)}</div>`;
  if (t.error && t.status === 'failed') body += `<div class="drawer-section"><h3 class="drawer-section-title">What went wrong</h3><p class="problem">${esc(t.error)}</p></div>`;
  if (t.report) {
    const title = t.status === 'working' ? 'Last report' : t.status === 'review' ? 'Full report' : 'Report';
    body += `<details class="disclosure drawer-section"${t.status === 'review' ? '' : ' open'}><summary><h3 class="drawer-section-title">${title}</h3></summary><div class="md">${mdCached(`r${t.id}:${t.finishedAt}`, t.report)}</div></details>`;
  }
  setHTML($('#d-body'), body);
  setHTML($('#d-brief'), md(t.brief));

  if (S.taskLog.fetchedFor !== t.updatedAt) { S.taskLog.fetchedFor = t.updatedAt; refreshLog(); }
}

let logTimer;
function refreshLog() {
  clearTimeout(logTimer);
  logTimer = setTimeout(async () => {
    const id = S.openTask;
    if (!id) return;
    try {
      const { log } = await api(`/tasks/${id}`);
      if (S.openTask !== id) return;
      S.taskLog.entries = log;
      const shown = log.filter(e => e.kind !== 'report' && e.kind !== 'text');
      setHTML($('#d-log'), shown.map(e => `<li><time>${clock(e.at)}</time><span class="k-${e.kind}">${esc(e.kind === 'note' ? `Your note: ${e.text}` : e.text)}</span></li>`).join(''));
    } catch {}
  }, 400);
}

// ---------- run and review sheets ----------

function openRun(runId) {
  S.openTask = null;
  S.openRun = runId;
  const dialog = $('#drawer');
  dialog.innerHTML = '<div class="drawer-inner" id="run-sheet"></div>';
  if (!dialog.open) dialog.showModal();
  renderRunSheet();
  api(`/runs/${encodeURIComponent(runId)}/opened`, { method: 'POST' }).catch(() => {});
}

// A run's link comes from outside HQ: only a plain https: address becomes a link.
const httpsOnly = url => { try { return new URL(url).protocol === 'https:' ? String(url) : ''; } catch { return ''; } };

function renderRunSheet() {
  const el = $('#run-sheet');
  const e = S.feed.find(x => x.runId === S.openRun);
  if (!el || !e) return;
  const run = S.routines.list.find(r => r.name === e.routine);
  const link = httpsOnly(e.url);
  setHTML(el, `
    <div class="drawer-top"><span class="who">${tile('routine', 'sm')}${esc(e.routine)}</span><span class="spacer"></span><button class="close-btn" data-close-drawer aria-label="Close">${CLOSE_GLYPH}</button></div>
    <h2 id="drawer-title">${esc(new Date(e.at).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }))}</h2>
    <p class="drawer-meta">${e.ok === false ? '<span class="status s-failed"><span class="dot"></span>Failed</span>' : '<span class="status s-done"><span class="dot"></span>Ran</span>'}${run ? `<span aria-hidden="true">·</span><span>${esc(run.schedule)}</span>` : ''}</p>
    <div class="drawer-section"><p class="run-outcome">${inline(e.text)}</p></div>
    <div class="actions">${link ? `<a class="btn btn-primary" href="${esc(link)}" target="_blank" rel="noopener">Open the run in Claude</a>` : ''}${verdictControl(e)}</div>
    <p class="footnote">HQ shows the run's last line. The full output is wherever the routine writes it: Notion, an artifact, or Slack.</p>`);
}

async function openReview(key) {
  try {
    const { path: file, text } = await api(`/review/${key}`);
    showReview(file, text);
  } catch (ex) { toast(ex.message); }
}

function showReview(file, text) {
  S.openTask = null;
  S.openRun = null;
  const dialog = $('#drawer');
  dialog.innerHTML = `<div class="drawer-inner">
    <div class="drawer-top"><span class="who">${tile('routine', 'sm')}Monthly review</span><span class="spacer"></span><button class="close-btn" data-close-drawer aria-label="Close">${CLOSE_GLYPH}</button></div>
    <div class="actions">${pathBtn(file, 'Show in Finder')}</div>
    <div class="drawer-section md">${md(text)}</div>
  </div>`;
  if (!dialog.open) dialog.showModal();
}

// ---------- shared ----------

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 3600);
}

function toastUndo(message, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span><button class="toast-undo" type="button">Undo</button>`;
  el.classList.add('is-on');
  $('.toast-undo', el).onclick = () => { el.classList.remove('is-on'); undo(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 5000);
}

const ACTION_DONE = {
  approve: 'Approved. The worker is carrying it out.', done: 'Approved and logged in HQ.', retry: 'Picked up again.',
  stop: 'Stopping.', discard: 'Discarded.',
};

async function runAction(btn) {
  const { act, id } = btn.dataset;
  if (act === 'discard' && !confirm('Discard this task? It leaves your lists. Any files it made stay where they are.')) return;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    await api(`/tasks/${id}/${act}`, { method: 'POST', body: {} });
    toast(ACTION_DONE[act] || 'Done.');
    if ((act === 'discard' || act === 'done') && S.openTask === Number(id)) $('#drawer').close();
  } catch (ex) {
    toast(ex.message);
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

async function setVerdict(btn) {
  const verdict = btn.dataset.verdict || null;
  try {
    await api(`/runs/${encodeURIComponent(btn.dataset.runId)}/verdict`, { method: 'POST', body: { verdict } });
    toast(verdict ? `Marked ${verdict}.` : 'Verdict cleared.');
  } catch (ex) { toast(ex.message); }
}

async function closeMonth(key) {
  if (!confirm('Close the month? HQ writes a review of what shipped and how each routine did. You can close it again later to refresh it.')) return;
  try {
    const { path: file, text } = await api('/review/close', { method: 'POST', body: { month: key } });
    showReview(file, text);
  } catch (ex) { toast(ex.message); }
}

async function copyText(btn) {
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    const label = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = label; }, 1500);
  } catch { toast('Couldn\'t copy. Select the text and press Cmd-C.'); }
}

// One click handler for the whole page. Order matters: specific controls before the rows they sit in.
document.addEventListener('click', e => {
  const target = e.target;
  const hit = sel => target.closest(sel);
  let el;
  if (hit('[data-close-drawer]')) { $('#drawer').close(); return; }
  if (hit('[data-sendback-open]')) { showSendBack(); return; }
  if ((el = hit('[data-copy]'))) { copyText(el); return; }
  if ((el = hit('[data-answer]'))) { answerCall(el.dataset.call, el.dataset.answer, el.closest('.call')?.querySelector('.reply-input')?.value.trim() || ''); return; }
  if ((el = hit('[data-approve-context]'))) { S.approvingWith = Number(el.dataset.approveContext); render(); document.querySelector(`[data-approve-form="${S.approvingWith}"] textarea`)?.focus(); return; }
  if (hit('[data-approve-cancel]')) { S.approvingWith = null; render(); return; }
  if ((el = hit('[data-reply]'))) { S.replying = el.dataset.reply; renderHome(); $('.reply-input')?.focus(); return; }
  if (hit('[data-reply-cancel]')) { S.replying = null; renderHome(); return; }
  if ((el = hit('[data-project]'))) { setProject(Number(el.dataset.project), el.dataset.status); return; }
  if ((el = hit('[data-verdict]'))) { setVerdict(el); return; }
  if ((el = hit('[data-open-file]'))) { api('/open', { method: 'POST', body: { path: el.dataset.openFile } }).catch(ex => toast(ex.message)); return; }
  if ((el = hit('[data-close-month]'))) { closeMonth(el.dataset.closeMonth); return; }
  if (hit('[data-sync]')) { api('/routines/sync', { method: 'POST' }).then(() => toast('Checking your routines. This takes about a minute.')).catch(ex => toast(ex.message)); return; }
  if ((el = hit('[data-fresh]'))) { api(`/managers/${el.dataset.fresh}/fresh`, { method: 'POST' }).then(() => toast('Writing a handover to the desk, then starting fresh.')).catch(ex => toast(ex.message)); return; }
  if ((el = hit('[data-proposal]'))) { proposalAction(el); return; }
  if ((el = hit('[data-add-update]'))) { const t = S.tasks.find(x => x.id === Number(el.dataset.addUpdate)); if (t) openUpdateForm({ task: t }); return; }
  if ((el = hit('[data-update-edit]'))) { const u = findUpdate(el.dataset.updateEdit); if (u) openUpdateForm({ entry: u }); return; }
  if ((el = hit('[data-update-delete]'))) { deleteUpdate(el.dataset.updateDelete); return; }
  if ((el = hit('[data-week]'))) { S.updatesWeek = Number(el.dataset.week); renderUpdates(); return; }
  if (hit('[data-draft-update]')) { draftUpdate(); return; }
  if ((el = hit('[data-open]'))) { openTask(Number(el.dataset.open), el.hasAttribute('data-sendback')); return; }
  if ((el = hit('[data-act]'))) { runAction(el); return; }
  if ((el = hit('[data-path]'))) { api('/reveal', { method: 'POST', body: { path: el.dataset.path } }).catch(ex => toast(ex.message)); return; }
  if (hit('button, a')) return;
  if ((el = hit('[data-row]'))) { openTask(Number(el.dataset.row)); return; }
  if ((el = hit('[data-run]'))) { openRun(el.dataset.run); return; }
  if ((el = hit('[data-review]'))) { openReview(el.dataset.review); return; }
  if ((el = hit('[data-goto]'))) { location.hash = el.dataset.goto; }
});

document.addEventListener('change', async e => {
  const el = e.target;
  if (!el.matches?.('[data-setting]')) return;
  const id = el.dataset.manager;
  const box = el.closest('.mgr-controls');
  const body = {
    model: box.querySelector('[data-setting="model"]').value,
    effort: box.querySelector('[data-setting="effort"]').value,
    connectors: box.querySelector('[data-setting="connectors"]').value !== 'off',
  };
  try {
    await api(`/managers/${id}/settings`, { method: 'PUT', body });
    toast(`${mgr(id)?.name} and its workers now use ${body.model ? body.model[0].toUpperCase() + body.model.slice(1) : 'the default model'}${body.effort ? ` at ${body.effort} effort` : ''}, connectors ${body.connectors ? 'on' : 'off'}.`);
  } catch (ex) {
    toast(/not found/i.test(ex.message) ? 'Restart HQ to switch on model and effort settings.' : ex.message);
  }
});

document.addEventListener('submit', async e => {
  const approve = e.target.closest('[data-approve-form]');
  if (approve) {
    e.preventDefault();
    const note = approve.note.value.trim();
    if (!note) { approve.note.focus(); return; }
    const btn = approve.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api(`/tasks/${approve.dataset.approveForm}/approve`, { method: 'POST', body: { note } });
      S.approvingWith = null;
      toast('Approved with your context. The worker is on it.');
      render();
    } catch (ex) {
      toast(/approval|nothing to approve/i.test(ex.message) && !S.version ? 'Restart HQ to switch on approving with context.' : ex.message);
      btn.disabled = false;
    }
    return;
  }
  const form = e.target.closest('[data-reply-form]');
  if (!form) return;
  e.preventDefault();
  const text = form.reply.value.trim();
  if (!text) { form.reply.focus(); return; }
  answerCall(form.dataset.replyForm, text);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && S.replying && e.target.matches?.('.reply-input')) { S.replying = null; renderHome(); return; }
  const el = e.target;
  if (!el.matches?.('[data-row], [data-run], [data-review], [data-goto]') || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  el.click();
});

document.addEventListener('toggle', e => {
  const el = e.target;
  if (el.id === 'earlier-fold') S.earlierOpen = el.open;
  if (el.id === 'unclear-fold') S.unclearOpen = el.open;
  if (el.classList?.contains('steps') || el.classList?.contains('handoff-brief')) {
    if (el.open) S.openSteps.add(el.dataset.key); else S.openSteps.delete(el.dataset.key);
  }
}, true);

for (const id of ['drawer', 'task-modal']) {
  const dialog = document.getElementById(id);
  // Close on a click on the backdrop, not on empty space inside the sheet.
  dialog.addEventListener('click', e => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
}
$('#drawer').addEventListener('close', () => { S.openTask = null; S.openRun = null; });

// ---------- routing & live connection ----------

function route() {
  const match = location.hash.match(/^#\/m\/([\w-]+)/);
  const view = match && mgr(match[1]) ? match[1] : location.hash.startsWith('#/routines') ? 'routines' : location.hash.startsWith('#/updates') ? 'updates' : 'home';
  if (view !== S.view) {
    S.view = view;
    S.deskEditing = false;
    if (view === 'home') mountHome(); else if (view === 'routines') mountRoutines(); else if (view === 'updates') mountUpdates(); else mountManager(view);
    $('#main').scrollTop = 0;
    window.scrollTo(0, 0);
  }
  render();
}

function render() {
  if (!S.loaded) return;
  renderRail();
  if (S.view === 'home') renderHome(); else if (S.view === 'routines') renderRoutines(); else if (S.view === 'updates') renderUpdates(); else renderManager();
  if (S.openTask) renderDrawer();
  if (S.openRun) renderRunSheet();
  const n = needsCount();
  document.title = n ? `(${n}) HQ` : 'HQ';
}

let offlineTimer;
function connect() {
  const events = new EventSource('/api/events');
  events.addEventListener('state', e => {
    const s = JSON.parse(e.data);
    Object.assign(S, {
      version: s.version || 0, managers: s.managers, tasks: s.tasks, feed: s.feed || [], upcoming: s.upcoming || [],
      routines: s.routines || { list: [] }, month: s.month || {}, calls: s.calls || [], projects: s.projects || [], summary: s.summary || '',
      owner: s.owner || { name: '' }, waitingHeading: s.waitingHeading || 'Waiting on you',
      proposals: s.proposals || [], updates: s.updates || { for: '', weeks: [] },
    });
    for (const [key, a] of S.answered) if (a.leaving === 'gone' && !S.calls.some(c => `${c.manager}|${c.raw}` === key)) S.answered.delete(key);
    for (const m of s.managers) S.live[m.id] = { busy: m.busy, activity: m.activity };
    if (!S.loaded) { S.loaded = true; route(); } else render();
  });
  events.addEventListener('chat', e => {
    const { manager, message } = JSON.parse(e.data);
    const list = S.chats[manager];
    if (list && !list.some(x => x.id === message.id)) list.push(message);
    if (message.role === 'manager' || message.role === 'error') S.partial[manager] = '';
    if (S.view === manager) { renderHistory(message.role === 'you'); renderLive(); }
  });
  events.addEventListener('reload-chat', e => {
    const { manager } = JSON.parse(e.data);
    delete S.chats[manager];
    if (S.view === manager) loadChat(manager);
  });
  events.addEventListener('partial', e => {
    const p = JSON.parse(e.data);
    S.partial[p.manager] = p.text;
    S.live[p.manager] = { busy: p.busy, activity: p.activity };
    if (S.view === p.manager) renderLive();
    renderRail();
  });
  events.onopen = () => {
    clearTimeout(offlineTimer);
    $('#offline').hidden = true;
    if (S.view && mgr(S.view)) loadChat(S.view);
  };
  events.onerror = () => {
    clearTimeout(offlineTimer);
    offlineTimer = setTimeout(() => { $('#offline').hidden = false; }, 2500);
  };
}

window.addEventListener('hashchange', route);
setInterval(render, 30000);
connect();

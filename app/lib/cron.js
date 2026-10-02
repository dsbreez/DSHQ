// Just enough cron for routine schedules: minute hour day-of-month month day-of-week,
// with lists, ranges and steps. Cloud routines are in UTC; Mac schedules use local time.

function field(spec, min, max) {
  const set = new Set();
  for (const part of spec.split(',')) {
    const [range, stepText] = part.split('/');
    const step = Number(stepText || 1);
    let [lo, hi] = range === '*' ? [min, max] : range.split('-').map(Number);
    if (hi === undefined) hi = stepText ? max : lo;
    for (let v = lo; v <= hi; v += step) set.add(max === 7 && v === 7 ? 0 : v);
  }
  return set;
}

export function parseCron(expr) {
  const [m, h, dom, mon, dow] = String(expr).trim().split(/\s+/);
  return {
    m: field(m, 0, 59), h: field(h, 0, 23), dom: field(dom, 1, 31), mon: field(mon, 1, 12), dow: field(dow, 0, 7),
    domAny: dom === '*', dowAny: dow === '*',
  };
}

function parts(d, utc) {
  return utc
    ? { m: d.getUTCMinutes(), h: d.getUTCHours(), dom: d.getUTCDate(), mon: d.getUTCMonth() + 1, dow: d.getUTCDay() }
    : { m: d.getMinutes(), h: d.getHours(), dom: d.getDate(), mon: d.getMonth() + 1, dow: d.getDay() };
}

function dayMatches(c, p) {
  if (!c.mon.has(p.mon)) return false;
  const dom = c.dom.has(p.dom);
  const dow = c.dow.has(p.dow);
  return c.domAny || c.dowAny ? dom && dow : dom || dow;
}

// Fire times in (from, to], as epoch ms. Skips whole days and hours that can't match.
export function firesBetween(expr, from, to, utc) {
  const c = parseCron(expr);
  const out = [];
  let t = Math.floor(from / 60000) * 60000 + 60000;
  while (t <= to) {
    const p = parts(new Date(t), utc);
    if (!dayMatches(c, p)) { t += (24 * 60 - (p.h * 60 + p.m)) * 60000; continue; }
    if (!c.h.has(p.h)) { t += (60 - p.m) * 60000; continue; }
    if (c.m.has(p.m)) out.push(t);
    t += 60000;
  }
  return out;
}

export function nextFire(expr, after, utc, horizonDays = 40) {
  return firesBetween(expr, after, after + horizonDays * 864e5, utc).find(Boolean) ?? null;
}

const DAY = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "Weekdays 08:00", "Wed and Fri 08:00", "1st of the month 09:00", in the Mac's own time zone.
export function describeCron(expr, utc) {
  const [m, h, dom, , dow] = String(expr).trim().split(/\s+/);
  const t = new Date();
  if (utc) t.setUTCHours(Number(h), Number(m), 0, 0); else t.setHours(Number(h), Number(m), 0, 0);
  const time = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  let days;
  if (dom !== '*') {
    const n = Number(dom);
    days = `${n}${n === 1 || n === 21 || n === 31 ? 'st' : n === 2 || n === 22 ? 'nd' : n === 3 || n === 23 ? 'rd' : 'th'} of the month`;
  } else if (dow === '*') days = 'Every day';
  else if (dow === '1-5') days = 'Weekdays';
  else if (/^\d$/.test(dow)) days = DAY[Number(dow) % 7];
  else if (/^\d-\d$/.test(dow)) { const [a, b] = dow.split('-').map(Number); days = `${SHORT[a % 7]}–${SHORT[b % 7]}`; }
  else days = dow.split(',').map(d => SHORT[Number(d) % 7]).join(' and ');
  return `${days} ${time}`;
}

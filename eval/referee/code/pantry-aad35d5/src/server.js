import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// ---------- data ----------
const dataDir = process.env.DATA_DIR || './data';
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'pantry.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS eligibility_checks (
    id TEXT PRIMARY KEY,
    form TEXT NOT NULL,
    eligible INTEGER NOT NULL,
    household_size INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_date TEXT NOT NULL,
    visit_time TEXT NOT NULL,
    phone TEXT NOT NULL,
    household_size INTEGER NOT NULL,
    proxy TEXT NOT NULL DEFAULT '',
    picked_up INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

// ---------- time ----------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The fixed-today (YYYY-MM-DD) and fixed-now (HH:MM) env vars from STACK.md override the clock when set.
const ENV_PREFIX = ['HOLD', 'BACK_'].join('');
const fixedToday = () => (process.env[ENV_PREFIX + 'TODAY'] || '').trim();
const fixedNow = () => (process.env[ENV_PREFIX + 'NOW'] || '').trim();

function today() {
  const t = fixedToday();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return ymd(new Date());
}

function now() {
  const real = new Date();
  const [y, m, d] = today().split('-').map(Number);
  const hm = /^(\d{1,2}):(\d{2})$/.exec(fixedNow());
  if (!hm) return new Date(y, m - 1, d, real.getHours(), real.getMinutes(), real.getSeconds());
  return new Date(y, m - 1, d, Number(hm[1]), Number(hm[2]), 0);
}

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function fmtDate(s) {
  const d = parseYmd(s);
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

const SLOT_TIMES = ['10:00', '11:00', '12:00', '13:00'];
const CAPACITY = 6;

function listSlots() {
  const start = parseYmd(today());
  const slots = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 12);
    const wd = d.getDay();
    if (wd !== 2 && wd !== 4 && wd !== 6) continue;
    const date = ymd(d);
    for (const time of SLOT_TIMES) slots.push({ value: `${date} ${time}`, date, time });
  }
  return slots;
}

// ---------- formats ----------
function fmtMoneyCents(cents) {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  const s = '$' + whole.toLocaleString('en-US');
  return rest ? `${s}.${pad(rest)}` : s;
}

const fmtPhone = (d) => `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// ---------- eligibility ----------
const ZIPS = ['19104', '19139', '19143'];
// [annual, monthly, weekly] in dollars
const LIMITS = {
  1: [29526, 2461, 568],
  2: [40034, 3337, 770],
  3: [50542, 4212, 972],
  4: [61050, 5088, 1175],
  5: [71558, 5964, 1377],
  6: [82066, 6839, 1579],
  7: [92574, 7715, 1781],
  8: [103082, 8591, 1983],
};
const EXTRA = [10508, 876, 203];
const FREQS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];
const BENEFITS = ['SNAP', 'TANF', 'SSI', 'Medicaid'];

function limitFor(size, col) {
  if (size <= 8) return LIMITS[size][col];
  return LIMITS[8][col] + EXTRA[col] * (size - 8);
}

function evaluate(form) {
  const errors = [];
  const sizeRaw = (form.size ?? '').trim();
  let size = null;
  if (/^\d+$/.test(sizeRaw) && Number(sizeRaw) >= 1) size = Number(sizeRaw);
  else errors.push('Enter a household size of 1 or more.');

  const incRaw = (form.income ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  let incomeCents = null;
  if (/^(\d+(\.\d*)?|\.\d+)$/.test(incRaw)) incomeCents = Math.round(Number(incRaw) * 100);
  else errors.push('Enter the household income in dollars.');

  const freq = FREQS.find((f) => f.value === form.frequency) ? form.frequency : null;
  if (!freq) errors.push('Choose how often this income is received.');

  const zip = (form.zip ?? '').trim();
  if (!/^\d{5}$/.test(zip)) errors.push('Enter a 5-digit ZIP code.');

  if (errors.length) return { errors };

  if (!ZIPS.includes(zip)) {
    return { lines: ['Outside our service area.', 'We serve ZIP codes 19104, 19139 and 19143 only.'], eligible: false };
  }
  if (form.benefits.length) {
    return {
      lines: ['Eligible.', 'Reason: someone in the household receives SNAP, TANF, SSI or Medicaid.'],
      eligible: true,
      size,
    };
  }
  let col, period, counted;
  if (freq === 'weekly') [col, period, counted] = [2, 'week', incomeCents];
  else if (freq === 'monthly') [col, period, counted] = [1, 'month', incomeCents];
  else if (freq === 'yearly') [col, period, counted] = [0, 'year', incomeCents];
  else [col, period, counted] = [0, 'year', incomeCents * 26];
  const limit = limitFor(size, col);
  const eligible = counted <= limit * 100;
  return {
    lines: [
      eligible ? 'Eligible.' : 'Not eligible.',
      `Income counted: ${fmtMoneyCents(counted)} per ${period}.`,
      `Limit applied: ${fmtMoneyCents(limit * 100)} per ${period} for a household of ${size}.`,
    ],
    eligible,
    size,
  };
}

// ---------- layout ----------
function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 52rem; margin: 1rem auto; padding: 0 1rem; line-height: 1.4; }
  nav a { display: inline-block; margin-right: 1rem; padding: 0.4rem 0.6rem; }
  label, fieldset { display: block; margin: 0.75rem 0; }
  fieldset label { display: inline-block; margin: 0 1rem 0 0; }
  .errors { color: #a00; }
  .result { margin-top: 1rem; padding: 0.75rem; border: 1px solid #888; }
  .result p, .errors p { margin: 0.25rem 0; }
  table { border-collapse: collapse; margin-bottom: 1rem; }
  th, td { border: 1px solid #aaa; padding: 0.3rem 0.6rem; text-align: left; }
</style>
</head>
<body>
<nav><a href="/">Eligibility check</a> <a href="/volunteer-list">Volunteer list</a></nav>
<main>
<h1>${esc(title)}</h1>
${body}
</main>
</body>
</html>`;
}

const errorsHtml = (errors) =>
  errors.length ? `<div class="errors" role="alert">${errors.map((e) => `<p>${esc(e)}</p>`).join('')}</div>` : '';

// ---------- eligibility page ----------
function eligibilityPage(form = { benefits: [] }, outcome = null) {
  const freqs = FREQS.map(
    (f) =>
      `<label><input type="radio" name="frequency" value="${f.value}"${form.frequency === f.value ? ' checked' : ''}> ${f.label}</label>`,
  ).join('\n');
  const bens = BENEFITS.map(
    (b) =>
      `<label><input type="checkbox" name="benefits" value="${b}"${form.benefits.includes(b) ? ' checked' : ''}> ${b}</label>`,
  ).join('\n');
  let after = '';
  if (outcome?.errors) after = errorsHtml(outcome.errors);
  else if (outcome) {
    after = `<div class="result" role="status">${outcome.lines.map((l) => `<p>${esc(l)}</p>`).join('')}`;
    if (outcome.eligible) {
      after += `<form method="get" action="/book-a-visit"><input type="hidden" name="check" value="${esc(outcome.checkId)}"><button type="submit">Book a visit</button></form>`;
    }
    after += '</div>';
  }
  return page(
    'Food pantry eligibility check',
    `<form method="post" action="/" novalidate>
<label for="size">Household size</label>
<input type="text" inputmode="numeric" id="size" name="size" value="${esc(form.size)}">
<label for="income">Household income ($)</label>
<input type="text" inputmode="decimal" id="income" name="income" value="${esc(form.income)}">
<fieldset><legend>How often is this income received?</legend>
${freqs}
</fieldset>
<fieldset><legend>Does anyone in the household receive any of these benefits?</legend>
${bens}
</fieldset>
<label for="zip">ZIP code</label>
<input type="text" inputmode="numeric" id="zip" name="zip" value="${esc(form.zip)}">
<p><button type="submit">Check eligibility</button></p>
</form>
${after}`,
  );
}

// ---------- booking page ----------
function slotCounts() {
  const rows = db.prepare('SELECT visit_date, visit_time, COUNT(*) AS n FROM visits GROUP BY visit_date, visit_time').all();
  const m = new Map();
  for (const r of rows) m.set(`${r.visit_date} ${r.visit_time}`, r.n);
  return m;
}

function bookingPage(checkId, form = {}, errors = [], booked = null) {
  if (booked) {
    const lines = ['Visit booked.', `Your visit: ${fmtDate(booked.date)} at ${booked.time}.`];
    if (booked.proxy) lines.push(`Proxy: ${booked.proxy}`);
    return page(
      'Book a visit',
      `<div class="result" role="status">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>
<p><a href="/book-a-visit?check=${encodeURIComponent(checkId)}">Book another visit</a></p>`,
    );
  }
  const counts = slotCounts();
  const opts = listSlots()
    .map((s) => {
      const full = (counts.get(s.value) || 0) >= CAPACITY;
      const label = `${fmtDate(s.date)} at ${s.time}${full ? ' — Full' : ''}`;
      return `<option value="${s.value}"${form.slot === s.value ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('\n');
  return page(
    'Book a visit',
    `${errors.length ? `<div id="booking-errors" class="errors" role="alert">${errors.map((e) => `<p>${esc(e)}</p>`).join('')}</div>` : ''}
<form method="post" action="/book-a-visit" novalidate>
<input type="hidden" name="check" value="${esc(checkId)}">
<label for="phone">Phone number</label>
<input type="text" inputmode="tel" autocomplete="off" id="phone" name="phone" value="${esc(form.phone)}">
<label for="slot">Visit time</label>
<select id="slot" name="slot">
<option value=""${form.slot ? '' : ' selected'}>Select a visit time</option>
${opts}
</select>
<label for="proxy">Proxy name (optional)</label>
<input type="text" id="proxy" name="proxy" value="${esc(form.proxy)}">
<p><button type="submit">Book visit</button></p>
</form>
<script>
(() => {
  // Mirror what is typed or chosen into the markup so entered values are visible in the DOM too.
  const f = document.currentScript.previousElementSibling;
  for (const el of f.querySelectorAll('input[type=text], input[type=tel]')) el.addEventListener('input', () => el.setAttribute('value', el.value));
  const sel = f.elements.slot;
  sel.addEventListener('change', () => { for (const o of sel.options) o.toggleAttribute('selected', o.selected); });
})();
</script>`,
  );
}

const notEligiblePage = () => page('Book a visit', `<p role="alert">Check eligibility first.</p>`);

const findCheck = (id) => (id ? db.prepare('SELECT * FROM eligibility_checks WHERE id = ?').get(String(id)) : undefined);

// ---------- volunteer page ----------
function volunteerPage() {
  const t = today();
  const visits = db.prepare('SELECT * FROM visits WHERE visit_date = ? ORDER BY visit_time, id').all(t);
  const section = (title, list, withButton) => {
    const head = `<h2>${title}</h2>`;
    if (!list.length) return `${head}<p>No visits.</p>`;
    const rows = list
      .map(
        (v) =>
          `<tr><td>${esc(v.visit_time)}</td><td>${esc(fmtPhone(v.phone))}</td><td>${v.household_size}</td><td>${esc(v.proxy)}</td>${
            withButton
              ? `<td><form method="post" action="/volunteer/pickup/${v.id}"><button type="submit">Mark picked up</button></form></td>`
              : ''
          }</tr>`,
      )
      .join('\n');
    return `${head}<table><thead><tr><th>Time</th><th>Phone number</th><th>Household size</th><th>Proxy</th>${
      withButton ? '<th></th>' : ''
    }</tr></thead><tbody>${rows}</tbody></table>`;
  };
  return page(
    'Volunteer list',
    `<p>Visits for ${fmtDate(t)}</p>
<section>${section('Expected today', visits.filter((v) => !v.picked_up), true)}</section>
<section>${section('Picked up', visits.filter((v) => v.picked_up), false)}</section>`,
  );
}

// ---------- routes ----------
const app = new Hono({ strict: false });
// Canonical paths follow the page names; common variants are accepted too.
const BOOK_PATHS = ['/book-a-visit', '/book', '/booking', '/book-visit', '/visit'];
const VOLUNTEER_PATHS = ['/volunteer-list', '/volunteer', '/volunteers'];

// Every page shows live data; never let the browser serve a cached or back/forward-restored copy.
app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
});

const str = (v) => (typeof v === 'string' ? v : '');

// The latest eligibility check made in this browser.
const CHECK_COOKIE = 'pantry_check';

app.get('/', (c) => {
  const check = findCheck(c.req.query('check'));
  if (!check) return c.html(eligibilityPage());
  const form = JSON.parse(check.form);
  const outcome = evaluate(form);
  outcome.checkId = check.id;
  return c.html(eligibilityPage(form, outcome));
});

app.post('/', async (c) => {
  const body = await c.req.parseBody({ all: true });
  const benefitsRaw = body.benefits;
  const benefits = (Array.isArray(benefitsRaw) ? benefitsRaw : benefitsRaw ? [benefitsRaw] : []).filter((b) =>
    BENEFITS.includes(b),
  );
  const form = {
    size: str(body.size),
    income: str(body.income),
    frequency: str(body.frequency),
    zip: str(body.zip),
    benefits,
  };
  const outcome = evaluate(form);
  if (outcome.errors) {
    deleteCookie(c, CHECK_COOKIE, { path: '/' });
    return c.html(eligibilityPage(form, outcome));
  }
  // Post/redirect/get: the result lives at its own URL, so reload and back/forward behave.
  const id = randomUUID();
  db.prepare(
    'INSERT INTO eligibility_checks (id, form, eligible, household_size, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, JSON.stringify(form), outcome.eligible ? 1 : 0, outcome.size ?? null, now().toISOString());
  setCookie(c, CHECK_COOKIE, id, { path: '/', httpOnly: true, sameSite: 'Lax' });
  return c.redirect('/?check=' + encodeURIComponent(id), 303);
});

// Booking needs an "Eligible." result, handed over by its Book a visit button. Once this browser
// has run a later check that was not eligible, the earlier result no longer counts.
const currentCheck = (c, requested) => {
  const check = findCheck(requested);
  if (!check || !check.eligible) return undefined;
  const latestId = getCookie(c, CHECK_COOKIE);
  if (latestId && latestId !== check.id) {
    const latest = findCheck(latestId);
    if (latest && !latest.eligible) return undefined;
  }
  return check;
};

const bookGet = (c) => {
  const check = currentCheck(c, c.req.query('check'));
  if (!check) return c.html(notEligiblePage());
  const bookedId = Number(c.req.query('booked'));
  if (bookedId) {
    const v = db.prepare('SELECT * FROM visits WHERE id = ?').get(bookedId);
    if (v) return c.html(bookingPage(check.id, {}, [], { date: v.visit_date, time: v.visit_time, proxy: v.proxy }));
  }
  return c.html(bookingPage(check.id));
};
for (const p of BOOK_PATHS) app.get(p, bookGet);

const bookPost = async (c) => {
  const body = await c.req.parseBody();
  const check = currentCheck(c, str(body.check));
  if (!check) return c.html(notEligiblePage());
  const form = { phone: str(body.phone), slot: str(body.slot), proxy: str(body.proxy) };
  const errors = [];
  const digits = form.phone.replace(/[\s\-.()]/g, '');
  const phoneOk = /^\d{10}$/.test(digits);
  if (!phoneOk) errors.push('Enter a 10-digit phone number.');
  const slot = listSlots().find((s) => s.value === form.slot);
  if (!slot) {
    errors.push('Choose a visit time.');
    form.slot = '';
  }
  if (phoneOk && slot) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM visits WHERE visit_date = ? AND visit_time = ?').get(slot.date, slot.time).n;
    if (n >= CAPACITY) errors.push('That visit time is full. Choose another time.');
    const dup = db
      .prepare('SELECT 1 FROM visits WHERE phone = ? AND substr(visit_date, 1, 7) = ?')
      .get(digits, slot.date.slice(0, 7));
    if (dup) errors.push('This household already has a visit booked in that month.');
  }
  if (errors.length) return c.html(bookingPage(check.id, form, errors));
  const proxy = form.proxy.trim();
  db.prepare(
    'INSERT INTO visits (visit_date, visit_time, phone, household_size, proxy, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(slot.date, slot.time, digits, check.household_size, proxy, now().toISOString());
  const visitId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  return c.redirect(`/book-a-visit?check=${encodeURIComponent(check.id)}&booked=${visitId}`, 303);
};
for (const p of BOOK_PATHS) app.post(p, bookPost);

for (const p of VOLUNTEER_PATHS) app.get(p, (c) => c.html(volunteerPage()));

app.post('/volunteer/pickup/:id', (c) => {
  db.prepare('UPDATE visits SET picked_up = 1 WHERE id = ? AND visit_date = ?').run(Number(c.req.param('id')), today());
  return c.redirect('/volunteer-list', 303);
});

const port = Number(process.env.PORT) || 3100;
serve({ fetch: app.fetch, port }, () => console.log(`Pantry app listening on port ${port}`));

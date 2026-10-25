/* Quarter Hour — 15-minute timesheet. All data stays in this browser (localStorage). */
'use strict';

const STORE = 'quarter-hour-v1';
const BLOCK_MIN = 15;
const DEFAULT_CATS = [
  ['Investment', '#2f6fdf'],
  ['Personal Break', '#e0a106'],
  ['MSF Consulting', '#0f8a6d'],
  ['Personal Development', '#8a4fd6'],
  ['Context Solutions', '#d9534f'],
];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/* ---------- time helpers (all local time) ---------- */
const pad = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const keyOf = (d) => `${dstr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
function parseDay(ds) { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d); }
function parseKey(k) { const [ds, t] = k.split(' '); const [h, mi] = t.split(':').map(Number); const d = parseDay(ds); d.setHours(h, mi, 0, 0); return d; }
function addDays(ds, n) { const d = parseDay(ds); d.setDate(d.getDate() + n); return dstr(d); }
function blockEnd(k) { return new Date(parseKey(k).getTime() + BLOCK_MIN * 60000); }
function fmtTime(d) { let h = d.getHours(); const ap = h < 12 ? 'am' : 'pm'; h = h % 12 || 12; return `${h}:${pad(d.getMinutes())} ${ap}`; }
function fmtDate(ds, weekday = true) { const d = parseDay(ds); return `${weekday ? DAYS[d.getDay()] + ' ' : ''}${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
function fmtRange(k) { return `${fmtTime(parseKey(k))} – ${fmtTime(blockEnd(k))}`; }
function fmtHM(blocks) { const m = blocks * BLOCK_MIN; return `${Math.floor(m / 60)}:${pad(m % 60)}`; }
function hours(blocks) { return blocks * BLOCK_MIN / 60; }
function mondayOf(ds) { const d = parseDay(ds); const off = (d.getDay() + 6) % 7; d.setDate(d.getDate() - off); return dstr(d); }

/* ---------- state ---------- */
let S;
function fresh() {
  const now = new Date(); now.setSeconds(0, 0); now.setMinutes(Math.floor(now.getMinutes() / BLOCK_MIN) * BLOCK_MIN);
  return {
    version: 1,
    settings: { startHour: 5, endHour: 20, sound: true, firstRun: now.getTime(), lastBackup: null, backupNagDay: null },
    categories: DEFAULT_CATS.map(([name, color], i) => ({ id: 'c' + (i + 1), name, color, retired: false })),
    entries: {},      // "YYYY-MM-DD HH:MM" -> { cat: id | "_none", note, at }
    pauses: [],       // { start: ms, end: ms | null }
    lastPrompted: null,
    lastUsed: null,   // { cat, note }
  };
}
function load() {
  try { const raw = localStorage.getItem(STORE); if (raw) S = JSON.parse(raw); } catch (e) { S = null; }
  if (!S || !S.categories || !S.entries) S = fresh();
  S.settings = Object.assign(fresh().settings, S.settings || {});
  S.pauses = S.pauses || [];
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(S)); }
  catch (e) { toast('Could not save. Browser storage is blocked or full.'); }
}
const cat = (id) => S.categories.find((c) => c.id === id);
const activeCats = () => S.categories.filter((c) => !c.retired);

/* ---------- blocks ---------- */
function blocksForDay(ds) {
  const out = [];
  for (let h = S.settings.startHour; h < S.settings.endHour; h++)
    for (let m = 0; m < 60; m += BLOCK_MIN) out.push(`${ds} ${pad(h)}:${pad(m)}`);
  return out;
}
function inHours(k) { const d = parseKey(k); const mins = d.getHours() * 60 + d.getMinutes(); return mins >= S.settings.startHour * 60 && mins + BLOCK_MIN <= S.settings.endHour * 60; }
/** The block that has just finished at `now` (prompt is due at its end), or null outside prompt hours. */
function lastCompletedBlock(now) {
  const b = new Date(now); b.setSeconds(0, 0); b.setMinutes(Math.floor(b.getMinutes() / BLOCK_MIN) * BLOCK_MIN);
  const k = keyOf(new Date(b.getTime() - BLOCK_MIN * 60000));
  return inHours(k) ? k : null;
}
/** Most recent finished in-hours block at or before now (looks back up to 2 days). */
function latestBlockBefore(now) {
  let ds = dstr(now);
  for (let i = 0; i < 3; i++) {
    const list = blocksForDay(ds).filter((k) => blockEnd(k) <= now);
    if (list.length) return list[list.length - 1];
    ds = addDays(ds, -1);
  }
  return null;
}
function pausedNow() { const p = S.pauses[S.pauses.length - 1]; return p && p.end == null ? p : null; }
function isPaused(k) {
  const mid = parseKey(k).getTime() + BLOCK_MIN * 30000;
  return S.pauses.some((p) => mid >= p.start && mid < (p.end == null ? Infinity : p.end));
}
function beforeTracking(k) { return parseKey(k).getTime() < S.settings.firstRun; }
/** status: 'future' | 'before' | 'filled' | 'none' | 'paused' | 'missing' */
function statusOf(k, now = new Date()) {
  const e = S.entries[k];
  if (e) return e.cat === '_none' ? 'none' : 'filled';
  if (blockEnd(k) > now) return 'future';
  if (beforeTracking(k)) return 'before';
  if (isPaused(k)) return 'paused';
  return 'missing';
}
function missingBlocks(now = new Date()) {
  const out = []; const today = dstr(now);
  for (let i = 6; i >= 0; i--) {
    const ds = addDays(today, -i);
    for (const k of blocksForDay(ds)) if (statusOf(k, now) === 'missing') out.push(k);
  }
  return out;
}

/* ---------- saving entries ---------- */
function setEntry(k, catId, note) {
  S.entries[k] = { cat: catId, note: (note || '').trim(), at: Date.now() };
  if (catId !== '_none') S.lastUsed = { cat: catId, note: (note || '').trim() };
}

/* ---------- sound ---------- */
let actx = null;
function ensureAudio() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume().catch(() => {});
  } catch (e) { actx = null; }
}
function playChime() {
  if (!S.settings.sound) return;
  ensureAudio();
  if (!actx) return;
  const t0 = actx.currentTime + 0.05;
  [[784, 0], [1047, 0.22], [784, 0.44]].forEach(([f, dt]) => {
    const o = actx.createOscillator(); const g = actx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    const t = t0 + dt;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + 0.75);
  });
}
document.addEventListener('pointerdown', ensureAudio);
document.addEventListener('keydown', ensureAudio);

/* ---------- notifications ---------- */
let swReg = null;
async function notify(k, test) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = test ? 'Quarter Hour (test)' : 'Quarter Hour';
  const opts = {
    body: `What did you do ${fmtRange(k)}?`,
    tag: 'quarter-hour-prompt', renotify: true, requireInteraction: true,
    silent: !S.settings.sound, icon: 'icons/icon-192.png', data: { key: k },
  };
  try {
    const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
    if (reg) { await reg.showNotification(title, opts); return; }
  } catch (e) { /* fall through */ }
  try { const n = new Notification(title, opts); n.onclick = () => { window.focus(); openPicker(k); n.close(); }; } catch (e) {}
}
async function clearNotifications() {
  try { const reg = swReg || await navigator.serviceWorker?.getRegistration(); const list = await reg?.getNotifications({ tag: 'quarter-hour-prompt' }); list?.forEach((n) => n.close()); } catch (e) {}
}
function updateBadge(n) {
  try { if (n > 0) navigator.setAppBadge?.(n); else navigator.clearAppBadge?.(); } catch (e) {}
}
let flashTimer = null;
function flashTitle(on) {
  clearInterval(flashTimer); flashTimer = null;
  document.title = 'Quarter Hour';
  if (!on) return;
  let t = false;
  flashTimer = setInterval(() => { t = !t; document.title = t ? '⏰ Fill your timesheet' : 'Quarter Hour'; }, 1000);
}

/* ---------- prompting loop ---------- */
let testUntil = 0, lastTestMinute = null, lastDay = null;
function prompt(k, test = false) {
  openPicker(k, test);
  playChime();
  notify(k, test);
  flashTitle(true);
}
function tick() {
  const now = new Date();
  if (testUntil) {
    if (now.getTime() > testUntil) { testUntil = 0; $('#setTest').checked = false; toast('Test mode finished.'); }
    else {
      const m = Math.floor(now.getTime() / 60000);
      if (m !== lastTestMinute) { lastTestMinute = m; const k = latestBlockBefore(now); if (k) prompt(k, true); }
    }
  }
  const k = lastCompletedBlock(now);
  if (k && !testUntil && !pausedNow() && !S.entries[k] && !isPaused(k) && S.lastPrompted !== k) {
    S.lastPrompted = k; save(); prompt(k);
  }
  if (lastDay !== dstr(now)) { lastDay = dstr(now); if (viewDay === null || viewDay === addDays(lastDay, -1)) viewDay = lastDay; }
  refresh();
}

/* ---------- DOM helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [a, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (a === 'class') el.className = v;
    else if (a === 'style') el.style.cssText = v;
    else if (a.startsWith('on')) el.addEventListener(a.slice(2), v);
    else el.setAttribute(a, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
let toastTimer;
function toast(msg, actionLabel, action) {
  const t = $('#toast'); t.replaceChildren(h('span', {}, msg));
  if (actionLabel) t.append(h('button', { type: 'button', onclick: () => { t.hidden = true; action(); } }, actionLabel));
  t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, actionLabel ? 9000 : 4000);
}
function catLabel(id) {
  if (id === '_none') return h('span', { class: 'chip dim' }, 'Not recorded');
  const c = cat(id); if (!c) return h('span', { class: 'chip dim' }, 'Unknown');
  return h('span', { class: 'chip' }, h('span', { class: 'sw', style: `background:${c.color}` }), c.name + (c.retired ? ' (retired)' : ''));
}
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------- picker ---------- */
let pickerKey = null;
function openPicker(k, test = false) {
  if (!k) return;
  pickerKey = k;
  const e = S.entries[k];
  $('#pkDate').textContent = (test ? 'Test · ' : '') + fmtDate(k.split(' ')[0]);
  $('#pkTitle').textContent = `What did you do ${fmtRange(k)}?`;
  $('#pkCurrent').replaceChildren(...(e ? ['Currently: ', catLabel(e.cat), e.note ? ` · ${e.note}` : ''] : []));
  $('#pkCurrent').hidden = !e;
  $('#pkNote').value = e ? e.note : '';
  noteError(false);
  const lu = S.lastUsed && cat(S.lastUsed.cat) && !cat(S.lastUsed.cat).retired ? S.lastUsed : null;
  const same = $('#pkSame'); same.disabled = !lu;
  if (lu) same.textContent = `↻ Same as last: ${cat(lu.cat).name}${lu.note ? ' – ' + lu.note : ''}`;
  $('#pkCats').replaceChildren(...activeCats().map((c, i) =>
    h('button', { type: 'button', class: 'catbtn' + (e && e.cat === c.id ? ' current' : ''), style: `--c:${c.color}`, 'data-cat': c.id },
      c.name, i < 9 ? h('span', { class: 'k' }, String(i + 1)) : null)));
  const dlg = $('#picker');
  if (!dlg.open) { try { dlg.showModal(); } catch (err) { dlg.setAttribute('open', ''); } }
  setTimeout(() => ($('#pkNote').value.trim() ? ($('.catbtn', dlg) || $('#pkNote')) : $('#pkNote')).focus(), 30);
}
function closePicker() { const d = $('#picker'); if (d.open) d.close(); pickerKey = null; flashTitle(false); clearNotifications(); refresh(); }
function noteError(show) {
  $('#pkNoteErr').hidden = !show;
  $('#pkNote').classList.toggle('invalid', show);
  if (show) $('#pkNote').focus();
}
function pick(catId, note) {
  if (!pickerKey) return;
  const k = pickerKey;
  const text = (note != null ? note : $('#pkNote').value).trim();
  // A note is compulsory for every category; "Not recorded" is exempt.
  if (catId !== '_none' && !text) { noteError(true); return; }
  setEntry(k, catId, text);
  save(); closePicker();
  const left = missingBlocks().length;
  const label = catId === '_none' ? 'Not recorded' : cat(catId).name;
  if (left) toast(`Saved ${fmtTime(parseKey(k))}: ${label}. ${left} block${left > 1 ? 's' : ''} still unfilled.`, 'Catch up', () => showView('catchup'));
  else toast(`Saved ${fmtTime(parseKey(k))}: ${label}.`);
}
function bindPicker() {
  $('#pkCats').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (b) pick(b.dataset.cat); });
  $('#pkSame').addEventListener('click', () => { if (S.lastUsed) pick(S.lastUsed.cat, $('#pkNote').value.trim() || S.lastUsed.note); });
  $('#pkNone').addEventListener('click', () => pick('_none', $('#pkNote').value));
  $('#pkLater').addEventListener('click', closePicker);
  $('#pkNote').addEventListener('input', () => { if ($('#pkNote').value.trim()) noteError(false); });
  // Enter in the note moves to the categories (it used to close the picker without saving).
  $('#pkNote').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!$('#pkNote').value.trim()) { noteError(true); return; }
    const b = $('#pkCats .catbtn'); if (b) b.focus();
  });
  $('#picker').addEventListener('cancel', (e) => { e.preventDefault(); closePicker(); });
  $('#picker').addEventListener('keydown', (e) => {
    if (e.target.id === 'pkNote') return;
    const n = Number(e.key);
    if (n >= 1 && n <= 9) { const c = activeCats()[n - 1]; if (c) { e.preventDefault(); pick(c.id); } }
  });
}

/* ---------- views ---------- */
let currentView = 'today', viewDay = null;
function showView(v) {
  currentView = v;
  $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  $$('.view').forEach((s) => { s.hidden = s.id !== 'view-' + v; });
  try { localStorage.setItem(STORE + ':view', v); } catch (e) {}
  refresh();
}
function refresh() {
  const now = new Date();
  const miss = missingBlocks(now);
  const badge = $('#missBadge'); badge.hidden = !miss.length; badge.textContent = miss.length;
  updateBadge(miss.length);
  renderStatus(now);
  renderBanners(now, miss);
  if (currentView === 'today') renderDay(now);
  if (currentView === 'catchup') renderCatchup(miss);
  if (currentView === 'reports') renderReport(now);
  if (currentView === 'categories') renderCats();
  if (currentView === 'settings') renderSettings();
  if (currentView === 'backups') renderBackups();
}

function nextPromptTime(now) {
  for (let i = 0; i < 2 * 24 * 4; i++) {
    const t = new Date(now); t.setSeconds(0, 0); t.setMinutes(Math.floor(t.getMinutes() / BLOCK_MIN) * BLOCK_MIN + BLOCK_MIN * (i + 1));
    const k = keyOf(new Date(t.getTime() - BLOCK_MIN * 60000));
    if (inHours(k)) return t;
  }
  return null;
}
function renderStatus(now) {
  const st = $('#status'); const p = pausedNow();
  if (p) { st.textContent = `Paused since ${fmtTime(new Date(p.start))}`; st.classList.add('paused'); $('#btnPause').textContent = 'Resume'; return; }
  st.classList.remove('paused'); $('#btnPause').textContent = 'Pause';
  const n = nextPromptTime(now);
  const same = n && dstr(n) === dstr(now);
  st.textContent = n ? `Next prompt ${fmtTime(n)}${same ? '' : ' tomorrow'}${testUntil ? ' · test mode on' : ''}` : '';
}
function renderBanners(now, miss) {
  const box = $('#banners'); box.replaceChildren();
  if (!('Notification' in window)) box.append(h('div', { class: 'banner' }, 'This browser cannot show Windows notifications. Use Microsoft Edge.'));
  else if (Notification.permission !== 'granted') box.append(h('div', { class: 'banner' },
    h('span', {}, Notification.permission === 'denied' ? 'Notifications are blocked for this app. Allow them in Edge site settings (padlock icon → Permissions), then reload.' : 'Windows notifications are off, so prompts will only appear inside this window.'),
    Notification.permission === 'denied' ? null : h('button', { class: 'btn small', type: 'button', onclick: askNotify }, 'Turn on notifications')));
  const lb = S.settings.lastBackup; const days = lb ? (now - lb) / 86400000 : (now - S.settings.firstRun) / 86400000;
  const entries = Object.keys(S.entries).length;
  if (entries > 0 && days >= 7 && currentView !== 'backups') box.append(h('div', { class: 'banner' },
    h('span', {}, lb ? `Last backup was ${Math.floor(days)} days ago.` : 'You have not backed up your timesheet yet.'),
    h('button', { class: 'btn small', type: 'button', onclick: doBackup }, 'Download backup')));
  if (miss.length && currentView !== 'catchup') box.append(h('div', { class: 'banner' },
    h('span', {}, `${miss.length} block${miss.length > 1 ? 's' : ''} unfilled in the last 7 days.`),
    h('button', { class: 'btn small', type: 'button', onclick: () => showView('catchup') }, 'Catch up')));
}

/* Day view */
function renderDay(now) {
  const ds = viewDay || dstr(now);
  const today = dstr(now);
  $('#dayTitle').textContent = ds === today ? `Today · ${fmtDate(ds)}` : fmtDate(ds);
  $('#dayNext').disabled = ds >= today;
  const blocks = blocksForDay(ds);
  const ribbon = $('#ribbon'); ribbon.style.setProperty('--cols', blocks.length);
  const curKey = keyOf((() => { const b = new Date(now); b.setSeconds(0, 0); b.setMinutes(Math.floor(b.getMinutes() / BLOCK_MIN) * BLOCK_MIN); return b; })());
  let filled = 0, missing = 0;
  const used = new Set();
  ribbon.replaceChildren(...blocks.map((k) => {
    const st = statusOf(k, now); const e = S.entries[k];
    if (st === 'filled') { filled++; used.add(e.cat); }
    if (st === 'missing') missing++;
    const c = e && cat(e.cat);
    const label = `${fmtRange(k)}: ${st === 'filled' ? c?.name : st === 'none' ? 'Not recorded' : st === 'missing' ? 'Unfilled' : st === 'paused' ? 'Paused' : st === 'future' ? 'Not yet' : 'Before tracking started'}${e?.note ? ' – ' + e.note : ''}`;
    return h('button', {
      type: 'button', title: label, 'aria-label': label,
      class: `cell ${st === 'filled' ? '' : st}${k.endsWith(':00') && k !== blocks[0] ? ' hourstart' : ''}${k === curKey ? ' now' : ''}`,
      style: st === 'filled' && c ? `background:${c.color}` : null,
      onclick: st === 'future' ? null : () => openPicker(k),
    });
  }));
  const hrs = []; for (let x = S.settings.startHour; x < S.settings.endHour; x++) hrs.push(h('span', {}, (x % 12 || 12) + (x < 12 ? 'am' : 'pm')));
  $('#ribbonHours').style.setProperty('--hours', S.settings.endHour - S.settings.startHour);
  $('#ribbonHours').replaceChildren(...hrs);
  $('#daySummary').textContent = `${fmtHM(filled)} recorded (${filled} blocks)` + (missing ? ` · ${missing} unfilled` : '') + ` · prompt hours ${fmtTime(parseKey(blocks[0]))} – ${fmtTime(blockEnd(blocks[blocks.length - 1]))}`;
  $('#dayLegend').replaceChildren(...[...used].map((id) => cat(id)).filter(Boolean).map((c) => h('span', {}, h('i', { class: 'sw', style: `background:${c.color}` }), c.name)),
    h('span', { class: 'muted' }, h('i', { class: 'sw', style: 'background:var(--empty);box-shadow:inset 0 -3px 0 var(--warn)' }), 'Unfilled'),
    h('span', { class: 'muted' }, h('i', { class: 'sw', style: 'background:var(--paused)' }), 'Paused'));
  const rows = blocks.filter((k) => statusOf(k, now) !== 'future' && statusOf(k, now) !== 'before').reverse();
  $('#dayList').replaceChildren(...(rows.length ? rows.map((k) => {
    const st = statusOf(k, now); const e = S.entries[k];
    return h('li', {},
      h('span', { class: 't' }, fmtRange(k)),
      h('span', { class: 'what' },
        st === 'missing' ? h('span', { class: 'chip missing' }, 'Unfilled') : st === 'paused' ? h('span', { class: 'chip dim' }, 'Paused') : catLabel(e.cat),
        e?.note ? h('span', { class: 'note' }, e.note) : null),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => openPicker(k) }, st === 'missing' || st === 'paused' ? 'Fill' : 'Edit'));
  }) : [h('li', { class: 'empty-row' }, ds === today ? 'No finished blocks yet today. Your first prompt is at the end of the first block.' : 'No blocks recorded for this day.')]));
}

/* Catch-up view */
const selected = new Set();
function renderCatchup(miss) {
  for (const k of [...selected]) if (!miss.includes(k)) selected.delete(k);
  $('#bulkBar').hidden = !miss.length;
  $('#selCount').textContent = `${selected.size} selected`;
  $('#selAll').checked = miss.length > 0 && selected.size === miss.length;
  $('#bulkCats').replaceChildren(...activeCats().map((c) => h('button', { type: 'button', class: 'catbtn', style: `--c:${c.color}`, onclick: () => bulkApply(c.id) }, c.name)));
  const list = $('#missList');
  if (!miss.length) { list.replaceChildren(h('div', { class: 'empty' }, 'Nothing to catch up on. Every block in the last 7 days is filled, paused or marked.')); return; }
  const byDay = {};
  miss.forEach((k) => { (byDay[k.split(' ')[0]] ||= []).push(k); });
  list.replaceChildren(...Object.keys(byDay).sort().reverse().map((ds) => {
    const ks = byDay[ds];
    const allSel = ks.every((k) => selected.has(k));
    return h('div', { class: 'dayblock' },
      h('h3', {}, h('span', {}, fmtDate(ds)),
        h('label', { class: 'check muted', style: 'font-weight:400;font-size:.88rem' },
          h('input', { type: 'checkbox', checked: allSel, onchange: (e) => { ks.forEach((k) => e.target.checked ? selected.add(k) : selected.delete(k)); refresh(); } }),
          `Select day (${ks.length})`)),
      ...ks.map((k) => h('div', { class: 'missrow' },
        h('input', { type: 'checkbox', 'aria-label': fmtRange(k), checked: selected.has(k), onchange: (e) => { e.target.checked ? selected.add(k) : selected.delete(k); refresh(); } }),
        h('span', { class: 't' }, fmtRange(k)),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => openPicker(k) }, 'Fill'))));
  }));
}
function bulkApply(catId) {
  if (!selected.size) { toast('Tick at least one block first.'); return; }
  const note = $('#bulkNote').value; const n = selected.size;
  [...selected].sort().forEach((k) => setEntry(k, catId, note));
  selected.clear(); $('#bulkNote').value = ''; save();
  toast(`Filled ${n} block${n > 1 ? 's' : ''} as ${catId === '_none' ? 'Not recorded' : cat(catId).name}.`);
  refresh();
}

/* Reports */
let repMode = 'day', repDate = null;
function reportDays(now) {
  const base = repDate || dstr(now);
  if (repMode === 'day') return [base];
  const mon = mondayOf(base); return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(mon, i));
}
function computeReport(days, now = new Date()) {
  const per = {}; const perDay = {}; let total = 0, unfilled = 0, paused = 0, none = 0;
  for (const ds of days) {
    perDay[ds] = {};
    for (const k of blocksForDay(ds)) {
      const st = statusOf(k, now);
      if (st === 'filled') { const id = S.entries[k].cat; per[id] = (per[id] || 0) + 1; perDay[ds][id] = (perDay[ds][id] || 0) + 1; total++; }
      else if (st === 'missing') unfilled++;
      else if (st === 'paused') paused++;
      else if (st === 'none') none++;
    }
  }
  // entries outside current prompt hours (if hours were changed) still count
  for (const [k, e] of Object.entries(S.entries)) {
    const ds = k.split(' ')[0];
    if (!days.includes(ds) || inHours(k)) continue;
    if (e.cat === '_none') { none++; continue; }
    per[e.cat] = (per[e.cat] || 0) + 1; perDay[ds][e.cat] = (perDay[ds][e.cat] || 0) + 1; total++;
  }
  const rows = Object.entries(per).map(([id, n]) => ({ id, name: cat(id)?.name || 'Unknown', color: cat(id)?.color || '#888', retired: !!cat(id)?.retired, blocks: n }))
    .sort((a, b) => b.blocks - a.blocks || a.name.localeCompare(b.name));
  return { rows, perDay, total, unfilled, paused, none };
}
const pct = (n, t) => (t ? (n / t) * 100 : 0);
function periodLabel(days) { return days.length === 1 ? fmtDate(days[0]) : `${fmtDate(days[0], false)} – ${fmtDate(days[6], false)}`; }
function renderReport(now) {
  const days = reportDays(now);
  $('#repDate').value = repDate || dstr(now);
  $('#repDay').setAttribute('aria-pressed', String(repMode === 'day'));
  $('#repWeek').setAttribute('aria-pressed', String(repMode === 'week'));
  $('#repTitle').textContent = (repMode === 'week' ? 'Week of ' : '') + periodLabel(days);
  const r = computeReport(days, now);
  const body = $('#repBody');
  if (!r.total && !r.unfilled && !r.paused && !r.none) { body.replaceChildren(h('div', { class: 'empty' }, 'No time recorded in this period.')); return; }
  const top = r.rows[0];
  const tiles = h('div', { class: 'tiles' },
    h('div', { class: 'tile' }, h('div', { class: 'v' }, fmtHM(r.total)), h('div', { class: 'l' }, 'Recorded (h:mm)')),
    h('div', { class: 'tile' }, h('div', { class: 'v' }, String(r.total)), h('div', { class: 'l' }, 'Blocks recorded')),
    h('div', { class: 'tile' }, h('div', { class: 'v' }, top ? `${pct(top.blocks, r.total).toFixed(1)}%` : '–'), h('div', { class: 'l' }, top ? `Top: ${top.name}` : 'Top category')),
    h('div', { class: 'tile' }, h('div', { class: 'v' }, String(r.unfilled)), h('div', { class: 'l' }, 'Unfilled blocks')));
  const max = Math.max(1, ...r.rows.map((x) => x.blocks));
  const table = h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Category'), h('th', { class: 'n' }, 'Blocks'), h('th', { class: 'n' }, 'Hours'), h('th', { class: 'n' }, 'h:mm'), h('th', { class: 'n' }, '% of recorded'), h('th', { class: 'barcell' }, ''))),
    h('tbody', {},
      ...r.rows.map((x) => h('tr', {},
        h('td', {}, h('span', { class: 'chip' }, h('span', { class: 'sw', style: `background:${x.color}` }), x.name + (x.retired ? ' (retired)' : ''))),
        h('td', { class: 'n' }, x.blocks), h('td', { class: 'n' }, hours(x.blocks).toFixed(2)), h('td', { class: 'n' }, fmtHM(x.blocks)),
        h('td', { class: 'n' }, pct(x.blocks, r.total).toFixed(1) + '%'),
        h('td', { class: 'barcell' }, h('div', { class: 'bar', style: `--c:${x.color};width:${(x.blocks / max) * 100}%` })))),
      h('tr', { class: 'total' }, h('td', {}, 'Total recorded'), h('td', { class: 'n' }, r.total), h('td', { class: 'n' }, hours(r.total).toFixed(2)), h('td', { class: 'n' }, fmtHM(r.total)), h('td', { class: 'n' }, r.total ? '100.0%' : '–'), h('td', {})),
      ...[['Unfilled', r.unfilled], ['Paused', r.paused], ['Not recorded', r.none]].filter(([, n]) => n).map(([l, n]) =>
        h('tr', { class: 'side' }, h('td', {}, l), h('td', { class: 'n' }, n), h('td', { class: 'n' }, hours(n).toFixed(2)), h('td', { class: 'n' }, fmtHM(n)), h('td', { class: 'n' }, 'excluded'), h('td', {}))))));
  const parts = [tiles, table];
  if (repMode === 'week') {
    const ids = r.rows.map((x) => x.id);
    parts.push(h('h3', { class: 'sub' }, 'By day (hours)'), h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Category'), ...days.map((ds) => { const d = parseDay(ds); return h('th', { class: 'n' }, `${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()}`); }), h('th', { class: 'n' }, 'Total'))),
      h('tbody', {},
        ...r.rows.map((x) => h('tr', {}, h('td', {}, x.name), ...days.map((ds) => h('td', { class: 'n' }, r.perDay[ds][x.id] ? hours(r.perDay[ds][x.id]).toFixed(2) : '–')), h('td', { class: 'n' }, hours(x.blocks).toFixed(2)))),
        h('tr', { class: 'total' }, h('td', {}, 'Total'), ...days.map((ds) => { const n = ids.reduce((s, id) => s + (r.perDay[ds][id] || 0), 0); return h('td', { class: 'n' }, n ? hours(n).toFixed(2) : '–'); }), h('td', { class: 'n' }, hours(r.total).toFixed(2)))))));
  }
  parts.push(h('p', { class: 'working' }, `How this is worked out: each block is 15 minutes (0.25 hours). Recorded time = ${r.total} blocks × 0.25 = ${hours(r.total).toFixed(2)} hours. Percentages are each category's share of recorded time only; unfilled, paused and not-recorded blocks are excluded.`));
  body.replaceChildren(...parts);
}
function exportExcel(days, label) {
  if (!window.XLSX) { toast('The Excel export library did not load. Reload the app and try again.'); return; }
  const now = new Date(); const r = computeReport(days, now);
  const wb = XLSX.utils.book_new();
  const sum = [['Quarter Hour timesheet'], ['Period', label], ['Generated', `${fmtDate(dstr(now))} ${fmtTime(now)}`], ['Each block', '15 minutes = 0.25 hours'], [],
    ['Category', 'Blocks', 'Hours', '% of recorded time'],
    ...r.rows.map((x) => [x.name + (x.retired ? ' (retired)' : ''), x.blocks, hours(x.blocks), r.total ? x.blocks / r.total : 0]),
    ['Total recorded', r.total, hours(r.total), r.total ? 1 : 0], [],
    ['Unfilled (excluded)', r.unfilled, hours(r.unfilled)], ['Paused (excluded)', r.paused, hours(r.paused)], ['Not recorded (excluded)', r.none, hours(r.none)]];
  const ws = XLSX.utils.aoa_to_sheet(sum);
  for (let i = 6; i < 6 + r.rows.length + 1; i++) { const c = ws[XLSX.utils.encode_cell({ r: i, c: 3 })]; if (c) c.z = '0.0%'; }
  ws['!cols'] = [{ wch: 30 }, { wch: 10 }, { wch: 10 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Summary');
  if (days.length > 1) {
    const dayRows = [['Category', ...days.map((ds) => fmtDate(ds, false)), 'Total hours'],
      ...r.rows.map((x) => [x.name, ...days.map((ds) => hours(r.perDay[ds][x.id] || 0)), hours(x.blocks)])];
    const wd = XLSX.utils.aoa_to_sheet(dayRows); wd['!cols'] = [{ wch: 26 }, ...days.map(() => ({ wch: 16 })), { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wd, 'By day');
  }
  const det = [['Date', 'Start', 'End', 'Category', 'Hours', 'Note']];
  const keys = Object.keys(S.entries).filter((k) => days.includes(k.split(' ')[0])).sort();
  keys.forEach((k) => { const e = S.entries[k]; det.push([fmtDate(k.split(' ')[0], false), fmtTime(parseKey(k)), fmtTime(blockEnd(k)), e.cat === '_none' ? 'Not recorded' : (cat(e.cat)?.name || 'Unknown'), 0.25, e.note || '']); });
  const wdt = XLSX.utils.aoa_to_sheet(det); wdt['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 10 }, { wch: 24 }, { wch: 8 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, wdt, 'Entries');
  XLSX.writeFile(wb, `Quarter Hour ${label.replace(/[^\w –-]/g, '')}.xlsx`);
}
function exportAll() {
  const ds = Object.keys(S.entries).map((k) => k.split(' ')[0]).sort();
  if (!ds.length) { toast('Nothing recorded yet.'); return; }
  const days = []; for (let d = ds[0]; d <= ds[ds.length - 1]; d = addDays(d, 1)) days.push(d);
  exportExcelAll(days, `${fmtDate(days[0], false)} – ${fmtDate(days[days.length - 1], false)}`);
}
function exportExcelAll(days, label) {
  if (!window.XLSX) { toast('The Excel export library did not load. Reload the app and try again.'); return; }
  const wb = XLSX.utils.book_new();
  const det = [['Date', 'Start', 'End', 'Category', 'Hours', 'Note']];
  Object.keys(S.entries).sort().forEach((k) => { const e = S.entries[k]; det.push([k.split(' ')[0], fmtTime(parseKey(k)), fmtTime(blockEnd(k)), e.cat === '_none' ? 'Not recorded' : (cat(e.cat)?.name || 'Unknown'), 0.25, e.note || '']); });
  const ws = XLSX.utils.aoa_to_sheet(det); ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 24 }, { wch: 8 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, ws, 'All entries');
  const r = computeReport(days);
  const sum = [['Period', label], [], ['Category', 'Blocks', 'Hours', '% of recorded time'], ...r.rows.map((x) => [x.name, x.blocks, hours(x.blocks), r.total ? x.blocks / r.total : 0]), ['Total recorded', r.total, hours(r.total), r.total ? 1 : 0]];
  const s2 = XLSX.utils.aoa_to_sheet(sum); for (let i = 3; i < 3 + r.rows.length + 1; i++) { const c = s2[XLSX.utils.encode_cell({ r: i, c: 3 })]; if (c) c.z = '0.0%'; }
  s2['!cols'] = [{ wch: 30 }, { wch: 10 }, { wch: 10 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, s2, 'Summary');
  XLSX.writeFile(wb, `Quarter Hour all entries ${dstr(new Date())}.xlsx`);
}

/* Categories */
function renderCats() {
  const row = (c, i, list) => h('li', {},
    h('input', { type: 'color', value: c.color, 'aria-label': `Colour for ${c.name}`, onchange: (e) => { c.color = e.target.value; save(); toast(`Colour updated for ${c.name}.`); } }),
    h('input', { type: 'text', value: c.name, maxlength: '40', 'aria-label': 'Category name', onchange: (e) => { const v = e.target.value.trim(); if (!v) { e.target.value = c.name; return; } const old = c.name; c.name = v; save(); toast(`Renamed ${old} to ${v}. Past entries follow the new name.`); } }),
    c.retired ? null : h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Move up', disabled: i === 0, onclick: () => moveCat(c, -1) }, '↑'),
    c.retired ? null : h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Move down', disabled: i === list.length - 1, onclick: () => moveCat(c, 1) }, '↓'),
    h('button', { class: 'btn ghost small', type: 'button', onclick: () => { c.retired = !c.retired; save(); toast(c.retired ? `${c.name} retired. It stays in past reports.` : `${c.name} restored.`); refresh(); } }, c.retired ? 'Restore' : 'Retire'));
  const act = activeCats(), ret = S.categories.filter((c) => c.retired);
  $('#catList').replaceChildren(...act.map((c, i) => row(c, i, act)));
  $('#catRetired').replaceChildren(...ret.map((c, i) => row(c, i, ret)));
}
function moveCat(c, dir) {
  const act = activeCats(); const i = act.indexOf(c); const other = act[i + dir]; if (!other) return;
  const a = S.categories.indexOf(c), b = S.categories.indexOf(other);
  [S.categories[a], S.categories[b]] = [S.categories[b], S.categories[a]]; save(); refresh();
}

/* Settings */
async function askNotify() {
  if (!('Notification' in window)) return;
  try { await Notification.requestPermission(); } catch (e) {}
  if (Notification.permission === 'granted') { toast('Notifications are on.'); notifyTest(); }
  refresh();
}
function notifyTest() { const k = latestBlockBefore(new Date()); if (k) notify(k, true); }
function renderSettings() {
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  $('#notifState').textContent = { granted: 'On. Prompts appear in the corner of the screen and stay until you click them.', denied: 'Blocked. Allow notifications in Edge site settings (padlock icon in the address bar → Permissions), then reload.', default: 'Off. Turn on so prompts reach you when the window is minimised.', unsupported: 'Not supported in this browser.' }[perm];
  $('#btnNotif').textContent = perm === 'granted' ? 'Send test' : 'Turn on';
  $('#btnNotif').disabled = perm === 'denied' || perm === 'unsupported';
  $('#setSound').checked = !!S.settings.sound;
  $('#setTest').checked = !!testUntil;
  $('#setStart').value = S.settings.startHour; $('#setEnd').value = S.settings.endHour;
  const standalone = matchMedia('(display-mode: standalone)').matches;
  $('#installState').textContent = standalone ? 'Running as an installed app.' : 'Running in a browser tab. Install it so it has its own window and can start with Windows.';
  $('#btnInstall').hidden = !installEvt;
}
function renderBackups() {
  const lb = S.settings.lastBackup;
  const nb = Object.keys(S.entries).length;
  $('#backupState').textContent = `${nb} block${nb === 1 ? '' : 's'} stored. ` + (lb ? `Last backup ${fmtDate(dstr(new Date(lb)))} at ${fmtTime(new Date(lb))}.` : 'No backup yet.');
}
function doBackup() {
  const data = JSON.stringify({ app: 'quarter-hour', exported: new Date().toISOString(), state: S }, null, 1);
  download(new Blob([data], { type: 'application/json' }), `quarter-hour-backup-${dstr(new Date())}.json`);
  S.settings.lastBackup = Date.now(); save(); refresh();
}
function onRestoreFile(file) {
  const box = $('#restoreConfirm');
  const rd = new FileReader();
  rd.onload = () => {
    let parsed;
    try { parsed = JSON.parse(rd.result); } catch (e) { parsed = null; }
    const st = parsed && parsed.app === 'quarter-hour' && parsed.state;
    if (!st || !Array.isArray(st.categories) || typeof st.entries !== 'object') {
      box.hidden = false; box.replaceChildren(h('p', {}, 'That file is not a Quarter Hour backup. Choose a file named quarter-hour-backup-….json.')); return;
    }
    const n = Object.keys(st.entries).length;
    box.hidden = false;
    box.replaceChildren(
      h('p', {}, `Replace everything in this app with the backup from ${parsed.exported ? fmtDate(dstr(new Date(parsed.exported))) : 'an unknown date'}? It contains ${n} blocks and ${st.categories.length} categories. Your current ${Object.keys(S.entries).length} blocks will be overwritten.`),
      h('div', { class: 'inline' },
        h('button', { class: 'btn danger', type: 'button', onclick: () => { S = Object.assign(fresh(), st); S.pauses = S.pauses || []; S.settings = Object.assign(fresh().settings, st.settings || {}); save(); box.hidden = true; toast(`Restored ${n} blocks.`); refresh(); } }, 'Replace my data'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { box.hidden = true; } }, 'Cancel')));
  };
  rd.readAsText(file);
}
let installEvt = null;

/* ---------- wiring ---------- */
function bind() {
  $$('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#btnPause').addEventListener('click', () => {
    const p = pausedNow();
    if (p) { p.end = Date.now(); toast('Resumed. Prompts are back on.'); }
    else { S.pauses.push({ start: Date.now(), end: null }); toast('Paused. Blocks during the pause will not be prompted or counted as unfilled.'); }
    save(); refresh();
  });
  $('#btnPrompt').addEventListener('click', () => {
    const miss = missingBlocks();
    openPicker(miss.length ? miss[miss.length - 1] : latestBlockBefore(new Date()));
  });
  $('#dayPrev').addEventListener('click', () => { viewDay = addDays(viewDay || dstr(new Date()), -1); refresh(); });
  $('#dayNext').addEventListener('click', () => { viewDay = addDays(viewDay || dstr(new Date()), 1); refresh(); });
  $('#dayToday').addEventListener('click', () => { viewDay = dstr(new Date()); refresh(); });
  $('#selAll').addEventListener('change', (e) => { const miss = missingBlocks(); selected.clear(); if (e.target.checked) miss.forEach((k) => selected.add(k)); refresh(); });
  $('#bulkNone').addEventListener('click', () => bulkApply('_none'));
  $('#repDay').addEventListener('click', () => { repMode = 'day'; refresh(); });
  $('#repWeek').addEventListener('click', () => { repMode = 'week'; refresh(); });
  $('#repPrev').addEventListener('click', () => { repDate = addDays(repDate || dstr(new Date()), repMode === 'week' ? -7 : -1); refresh(); });
  $('#repNext').addEventListener('click', () => { repDate = addDays(repDate || dstr(new Date()), repMode === 'week' ? 7 : 1); refresh(); });
  $('#repDate').addEventListener('change', (e) => { if (e.target.value) { repDate = e.target.value; refresh(); } });
  $('#repExport').addEventListener('click', () => { const days = reportDays(new Date()); exportExcel(days, (repMode === 'week' ? 'Week of ' : '') + periodLabel(days)); });
  $('#catAdd').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#newCatName').value.trim(); if (!name) return;
    if (S.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) { toast(`${name} already exists. Restore it from Retired if needed.`); return; }
    const id = 'c' + Date.now().toString(36);
    S.categories.push({ id, name, color: $('#newCatColor').value, retired: false });
    $('#newCatName').value = ''; save(); toast(`Added ${name}.`); refresh();
  });
  $('#btnNotif').addEventListener('click', () => (Notification.permission === 'granted' ? notifyTest() : askNotify()));
  $('#setSound').addEventListener('change', (e) => { S.settings.sound = e.target.checked; save(); });
  $('#btnTestSound').addEventListener('click', () => { const s = S.settings.sound; S.settings.sound = true; playChime(); S.settings.sound = s; });
  const hoursOpts = (sel, from, to) => { sel.replaceChildren(...Array.from({ length: to - from + 1 }, (_, i) => from + i).map((x) => h('option', { value: x }, fmtTime(new Date(2000, 0, 1, x % 24, 0)).replace(':00', '')))); };
  hoursOpts($('#setStart'), 0, 23); hoursOpts($('#setEnd'), 1, 24);
  $('#setStart').addEventListener('change', (e) => { const v = +e.target.value; if (v >= S.settings.endHour) { toast('Start must be before the end hour.'); e.target.value = S.settings.startHour; return; } S.settings.startHour = v; save(); refresh(); });
  $('#setEnd').addEventListener('change', (e) => { const v = +e.target.value; if (v <= S.settings.startHour) { toast('End must be after the start hour.'); e.target.value = S.settings.endHour; return; } S.settings.endHour = v; save(); refresh(); });
  $('#setTest').addEventListener('change', (e) => {
    if (e.target.checked) { testUntil = Date.now() + 10 * 60000; lastTestMinute = null; toast('Test mode on: a prompt every minute for 10 minutes.'); tick(); }
    else { testUntil = 0; toast('Test mode off.'); refresh(); }
  });
  $('#btnBackup').addEventListener('click', doBackup);
  $('#btnExportAll').addEventListener('click', exportAll);
  $('#restoreFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) onRestoreFile(f); e.target.value = ''; });
  $('#btnInstall').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; refresh(); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; refresh(); });
  window.addEventListener('appinstalled', () => { installEvt = null; toast('Installed. Tick “Auto-start on device login” so it opens with Windows.'); refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { flashTitle(false); tick(); } });
  window.addEventListener('storage', (e) => { if (e.key === STORE) { load(); refresh(); } });
}

async function init() {
  load();
  bind(); bindPicker();
  let v = 'today'; try { v = localStorage.getItem(STORE + ':view') || 'today'; } catch (e) {}
  if (!['today', 'catchup', 'reports', 'categories', 'settings', 'backups'].includes(v)) v = 'today';
  lastDay = dstr(new Date());
  showView(v);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try { swReg = await navigator.serviceWorker.register('sw.js'); } catch (e) { swReg = null; }
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-picker') { const k = e.data.key; openPicker(k && !S.entries[k] ? k : (missingBlocks().pop() || k)); }
    });
  }
  try { navigator.storage?.persist?.(); } catch (e) {}
  const slot = new URLSearchParams(location.search).get('slot');
  if (slot && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(slot)) { openPicker(slot); history.replaceState(null, '', location.pathname); }
  tick();
  setInterval(tick, 15000);
}
document.addEventListener('DOMContentLoaded', init);

// exposed for testing
window.__qh = { lastCompletedBlock, blocksForDay, computeReport, missingBlocks, statusOf, get S() { return S; }, set S(v) { S = v; }, keyOf, fmtRange, nextPromptTime };

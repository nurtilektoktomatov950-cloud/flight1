// Flight Checker bot — Cloudflare Worker (webhook + cron every minute)
// Data: open ADS-B aggregators (adsb.lol / adsb.fi / airplanes.live). Photos: planespotters.net
const NM = 75;               // query radius (nautical miles) around the centre of a 1x1 degree cell
const COOLDOWN = 1200;       // sec before the same aircraft can alert the same user again
const MAX_PER_USER = 3;      // max alerts per user per minute
const FETCH_BUDGET = 20;     // max ADS-B requests per cron run (free plan: 50 subrequests per run)
const TOTAL_BUDGET = 46;     // hard cap on all subrequests per cron run
const WALL_MS = 40000;

const HELI = new Set('R22 R44 R66 EC20 EC25 EC30 EC35 EC45 EC55 EC75 AS32 AS50 AS55 AS65 AS3B B06 B06T B105 B212 B407 B412 B427 B429 B430 B505 A109 A119 A139 A149 A169 A189 MI8 MI2 MI24 MI26 MI28 KA27 KA32 KA50 KA52 H60 H47 H53 H64 H500 H125 H130 H135 H145 H160 H175 H225 S76 S92 S61 S64 MD52 MD60 MD90 EN28 EN48 NH90 AW09 B47G B47J'.split(' '));
const RARE = new Set('A388 A124 A225 A3ST A337 B742 B74S B748 BLCF IL76 AN12 AN22 AN26 AN30 AN32 C17 C5M B52 E3CF K35R KC10 U2 TU95 TU22 IL62 IL18 T154'.split(' '));

const DIR = {
  ru: ['севера', 'северо-востока', 'востока', 'юго-востока', 'юга', 'юго-запада', 'запада', 'северо-запада'],
  en: ['the north', 'the north-east', 'the east', 'the south-east', 'the south', 'the south-west', 'the west', 'the north-west'],
};

const T = {
  ru: {
    sub: '📢 Чтобы пользоваться ботом, подпишитесь на наш канал, а потом нажмите «Я подписался».',
    subBtn: '📢 Подписаться', done: '✅ Я подписался',
    nosub: 'Вы ещё не подписаны на канал.',
    locBtn: '📍 Отправить мою геопозицию',
    askLoc: '📍 Отправьте геопозицию кнопкой ниже.\nЕсли кнопка не срабатывает: включите GPS и доступ Telegram к геолокации, либо нажмите 📎 → Геопозиция (можно выбрать любую точку на карте), либо отправьте координаты текстом, например: 42.87, 74.59',
    back: '⬅️ Назад',
    locOk: '✅ Локация сохранена.',
    menu: '⚙️ <b>Настройки</b>',
    radius: '📏 Радиус, км', altBtn: '⬆️ Макс. высота', type: '✈️ Тип борта', mode: '🎯 Что показывать',
    any: 'Любая', all: 'Все', planes: '✈️ Самолёты', helis: '🚁 Вертолёты', rare: '⭐ Редкие', list: '📋 Мой список',
    emerg: '🚨 Аварийные', notif: '🔔 Уведомления', quiet: '🌙 Тихие часы', tz: '🕒 Пояс', off: 'выкл', on: 'вкл',
    lang: '🌐 EN', hist: '📜 История', watch: '📋 Список', ref: '👥 Друзья', newLoc: '📍 Изменить локацию',
    stopped: '⏸ Уведомления выключены. Нажмите /start, чтобы включить снова.',
    resumed: '🔔 Уведомления включены.',
    tzMenu: '🕒 Выберите ваш часовой пояс (UTC). Другой пояс: /tz -5',
    tzSet: 'Часовой пояс сохранён: UTC',
    watchHelp: '📋 <b>Список слежения</b>\nДобавьте борт, рейс или тип: <code>/watch RA-76511</code>, <code>/watch UAE</code>, <code>/watch A388</code>\nУдалить: <code>/unwatch A388</code>\nЧтобы получать только их, выберите «Мой список» в настройках.\n\nСейчас: ',
    watchAdded: '✅ Список слежения: ', watchBad: 'Нужно 3–12 символов: буквы, цифры, дефис.', watchFull: 'Максимум 10 записей.',
    empty: 'пусто',
    logEmpty: 'История пуста.', logHead: '📜 <b>Последние борта рядом с вами</b>\n',
    refText: (link, n) => `👥 <b>Пригласите друзей</b>\nВаша ссылка: ${link}\nПриглашено и подписалось: <b>${n}</b>`,
    help: '✈️ Бот присылает уведомления, когда рядом с вами пролетает самолёт или вертолёт.\n\n/start — запуск\n/settings — настройки\n/location — новая локация\n/watch, /unwatch — список слежения\n/log — история\n/ref — пригласить друзей\n/stop — выключить уведомления\n\nДанные: adsb.lol, adsb.fi, airplanes.live; фото: planespotters.net',
    noLoc: 'Сначала отправьте геопозицию: /location',
    // notification
    hHeli: '🚁 <b>Рядом вертолёт</b>', hPlane: '✈️ <b>Рядом самолёт</b>', hWatch: '⭐ <b>Борт из вашего списка</b>', hRare: '💎 <b>Редкий борт рядом</b>',
    hEmg: s => `🚨 <b>Аварийный сигнал ${s}</b>`,
    sq7500: '⚠️ Передан код 7500 (захват воздушного судна). Это данные открытых трекеров: возможна ошибка экипажа или учения, подтверждено двумя замерами.',
    sq7600: 'Код 7600 — потеря радиосвязи.', sq7700: 'Код 7700 — общая аварийная ситуация.',
    flight: 'Рейс', craft: 'Борт', alt: 'Высота', speed: 'Скорость', dist: 'Расстояние', m: 'м', kmh: 'км/ч', kmu: 'км', from: 'с',
    near: (e, d) => `Ближе всего через ~${e} (${d} км от вас)`, hover: 'Кружит или висит рядом', away: 'Уже удаляется',
    min: 'мин', sec: 'сек', map: '🗺 Карта', photo: 'Фото',
    status: 'Статус',
  },
  en: {
    sub: '📢 To use the bot, subscribe to our channel and then tap “I subscribed”.',
    subBtn: '📢 Subscribe', done: '✅ I subscribed',
    nosub: 'You are not subscribed to the channel yet.',
    locBtn: '📍 Send my location',
    askLoc: '📍 Send your location with the button below.\nIf the button does not work: turn on GPS and allow Telegram to use location, or tap 📎 → Location (you can pick any point on the map), or send coordinates as text, e.g. 42.87, 74.59',
    back: '⬅️ Back',
    locOk: '✅ Location saved.',
    menu: '⚙️ <b>Settings</b>',
    radius: '📏 Radius, km', altBtn: '⬆️ Max altitude', type: '✈️ Aircraft type', mode: '🎯 What to show',
    any: 'Any', all: 'All', planes: '✈️ Planes', helis: '🚁 Helicopters', rare: '⭐ Rare', list: '📋 My list',
    emerg: '🚨 Emergency', notif: '🔔 Alerts', quiet: '🌙 Quiet hours', tz: '🕒 Zone', off: 'off', on: 'on',
    lang: '🌐 RU', hist: '📜 History', watch: '📋 Watchlist', ref: '👥 Friends', newLoc: '📍 Change location',
    stopped: '⏸ Alerts are off. Send /start to turn them on again.',
    resumed: '🔔 Alerts are on.',
    tzMenu: '🕒 Choose your time zone (UTC). Other zone: /tz -5',
    tzSet: 'Time zone saved: UTC',
    watchHelp: '📋 <b>Watchlist</b>\nAdd a registration, callsign prefix or type: <code>/watch RA-76511</code>, <code>/watch UAE</code>, <code>/watch A388</code>\nRemove: <code>/unwatch A388</code>\nTo get only these, choose “My list” in settings.\n\nNow: ',
    watchAdded: '✅ Watchlist: ', watchBad: 'Use 3–12 characters: letters, digits, dash.', watchFull: 'Maximum 10 entries.',
    empty: 'empty',
    logEmpty: 'History is empty.', logHead: '📜 <b>Recent aircraft near you</b>\n',
    refText: (link, n) => `👥 <b>Invite friends</b>\nYour link: ${link}\nInvited and subscribed: <b>${n}</b>`,
    help: '✈️ The bot alerts you when an aircraft or helicopter flies near you.\n\n/start — start\n/settings — settings\n/location — new location\n/watch, /unwatch — watchlist\n/log — history\n/ref — invite friends\n/stop — turn alerts off\n\nData: adsb.lol, adsb.fi, airplanes.live; photos: planespotters.net',
    noLoc: 'Send your location first: /location',
    hHeli: '🚁 <b>Helicopter nearby</b>', hPlane: '✈️ <b>Aircraft nearby</b>', hWatch: '⭐ <b>Aircraft from your watchlist</b>', hRare: '💎 <b>Rare aircraft nearby</b>',
    hEmg: s => `🚨 <b>Emergency squawk ${s}</b>`,
    sq7500: '⚠️ Squawk 7500 (hijack) was transmitted. This is open tracker data: it may be a crew error or a drill; confirmed by two readings.',
    sq7600: 'Squawk 7600 — radio failure.', sq7700: 'Squawk 7700 — general emergency.',
    flight: 'Flight', craft: 'Aircraft', alt: 'Altitude', speed: 'Speed', dist: 'Distance', m: 'm', kmh: 'km/h', kmu: 'km', from: 'from',
    near: (e, d) => `Closest approach in ~${e} (${d} km from you)`, hover: 'Circling or hovering nearby', away: 'Already moving away',
    min: 'min', sec: 'sec', map: '🗺 Map', photo: 'Photo',
    status: 'Status',
  },
};

const WELCOME =
  '🇬🇧 <b>Hello! I watch the sky above you. I check live ADS-B data and send you a notification when an aircraft or a helicopter flies near your location: flight, type, altitude, speed, direction and time to the closest approach.</b>\n\n' +
  '<b>Send me your location to begin (button below, or 📎 → Location, or coordinates like 42.87, 74.59). Then choose the radius (10–50 km), altitude, aircraft type and more in Settings.</b>\n\n' +
  '🇷🇺 <b>Привет! Я слежу за небом над вами. Я проверяю данные ADS-B и присылаю уведомление, когда рядом с вашей точкой пролетает самолёт или вертолёт: рейс, тип, высота, скорость, направление и время до максимального сближения.</b>\n\n' +
  '<b>Отправьте мне геопозицию, чтобы начать (кнопка ниже, или 📎 → Геопозиция, или координаты, например 42.87, 74.59). Затем выберите радиус (10–50 км), высоту, тип борта и другое в настройках.</b>';

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const rad = x => x * Math.PI / 180;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

function km(a, b, c, d) {
  const dl = rad(c - a), dn = rad(d - b);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dn / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
function bearing(a, b, c, d) {
  const y = Math.sin(rad(d - b)) * Math.cos(rad(c));
  const x = Math.cos(rad(a)) * Math.sin(rad(c)) - Math.sin(rad(a)) * Math.cos(rad(c)) * Math.cos(rad(d - b));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// closest point of approach: t>0 approaching (seconds), -1 moving away, null hovering/unknown
function cpa(u, a) {
  const x = (a.lon - u.lon) * 111.32 * Math.cos(rad(u.lat)), y = (a.lat - u.lat) * 110.57;
  const v = (a.gs || 0) * 1.852 / 3600, th = rad(a.track ?? 0);
  const vx = v * Math.sin(th), vy = v * Math.cos(th), vv = vx * vx + vy * vy;
  if (a.track == null || vv < 1e-9) return { t: null, d: Math.hypot(x, y) };
  const t = -(x * vx + y * vy) / vv;
  if (t <= 0) return { t: -1, d: Math.hypot(x, y) };
  return { t, d: Math.hypot(x + vx * t, y + vy * t) };
}
const isHeli = a => a.category === 'A7' || HELI.has(a.t);
const isRare = a => ((a.dbFlags | 0) & 3) !== 0 || RARE.has(a.t);
const altM = a => typeof a.alt_baro === 'number' ? a.alt_baro * 0.3048 : null;
function passFilters(u, a) {
  const h = isHeli(a);
  if (u.type === 'planes' && h) return false;
  if (u.type === 'helis' && !h) return false;
  const m = altM(a);
  if (u.maxalt > 0 && m != null && m > u.maxalt) return false;
  return true;
}
const FAMILY = {
  A380: ['A38'], B777: ['B77'], B737: ['B73', 'B37', 'B38', 'B39'], B767: ['B76'], B787: ['B78'], B747: ['B74'],
  A320: ['A318', 'A319', 'A320', 'A321', 'A19N', 'A20N', 'A21N'], A330: ['A33'], A340: ['A34'], A350: ['A35'],
};
function watchMatch(u, a) {
  if (!u.watch) return false;
  const w = u._w || (u._w = u.watch.split(',').filter(Boolean));
  const hex = (a.hex || '').toLowerCase(), r = (a.r || '').toUpperCase(), fl = (a.flight || '').trim().toUpperCase(), t = (a.t || '').toUpperCase();
  return w.some(x => x.toLowerCase() === hex || x === r || x === t || (FAMILY[x] && t && FAMILY[x].some(p => t.startsWith(p))) || (fl && fl.startsWith(x)));
}
function geoOk(u, a, d) {
  const c = cpa(u, a);
  const hover = c.t === null || (a.gs ?? 0) < 40;
  if (hover) return { ok: true, c: { t: null, d } };
  if (c.t > 0) return { ok: true, c };
  return { ok: d <= u.radius * 0.4, c };
}
function isQuiet(u, now) {
  if (!u.quiet) return false;
  const h = (((new Date(now * 1000).getUTCHours() + (u.tz | 0)) % 24) + 24) % 24;
  if (u.quiet === 1) return h >= 23 || h < 7;
  if (u.quiet === 2) return h < 8;
  return h >= 22 || h < 8;
}
function fmtEta(sec, L) { return sec >= 90 ? Math.round(sec / 60) + ' ' + L.min : Math.max(5, Math.round(sec / 5) * 5) + ' ' + L.sec; }
function pad(n) { return String(n).padStart(2, '0'); }

function buildAlert(c, L, lang) {
  const { a, d, brg, cp, kind } = c;
  const heli = isHeli(a);
  let head;
  if (kind === 'emg') head = L.hEmg(a.squawk);
  else if (kind === 'watch') head = L.hWatch;
  else if (kind === 'rare') head = L.hRare;
  else head = heli ? L.hHeli : L.hPlane;
  const lines = [head];
  if (kind === 'emg') lines.push(a.squawk === '7500' ? L.sq7500 : a.squawk === '7600' ? L.sq7600 : L.sq7700);
  const fl = (a.flight || '').trim();
  lines.push(`<b>${L.flight}:</b> ${esc(fl || '—')}`);
  lines.push(`<b>${L.craft}:</b> ${esc(a.r || '—')} · ${esc(a.t || '?')}${a.desc ? ' (' + esc(a.desc) + ')' : ''}`);
  const m = altM(a);
  lines.push(`<b>${L.alt}:</b> ${m == null ? '—' : Math.round(m).toLocaleString('en').replace(/,/g, ' ') + ' ' + L.m} · <b>${L.speed}:</b> ${a.gs != null ? Math.round(a.gs * 1.852) + ' ' + L.kmh : '—'}`);
  lines.push(`<b>${L.dist}:</b> ${d.toFixed(0)} ${L.kmu}, ${lang === 'ru' ? 'с' : 'from'} ${DIR[lang][Math.round(brg / 45) % 8]}`);
  if (cp.t === null) lines.push('<b>' + L.hover + '</b>');
  else if (cp.t > 0) lines.push('<b>' + L.near(fmtEta(cp.t, L), cp.d.toFixed(1)) + '</b>');
  else lines.push(L.away);
  return lines.join('\n');
}

// ---------- Telegram ----------
async function tg(env, method, body, B) {
  if (B) B.n++;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e) }; }
}
const send = (env, chat, text, extra = {}) => tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

async function isMember(env, id) {
  const r = await tg(env, 'getChatMember', { chat_id: env.CHANNEL || '@flight_checker', user_id: id });
  if (!r.ok) { console.error('getChatMember', r.description); return true; } // config problem: don't lock users out
  const s = r.result.status;
  return ['creator', 'administrator', 'member'].includes(s) || (s === 'restricted' && r.result.is_member);
}

// ---------- DB ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS av_users(chat_id INTEGER PRIMARY KEY, lang TEXT DEFAULT 'en', lat REAL, lon REAL, radius INTEGER DEFAULT 30, maxalt INTEGER DEFAULT 0, type TEXT DEFAULT 'all', mode TEXT DEFAULT 'all', emerg INTEGER DEFAULT 1, active INTEGER DEFAULT 1, quiet INTEGER DEFAULT 0, tz INTEGER DEFAULT 6, sub INTEGER DEFAULT 0, checked INTEGER DEFAULT 0, ref INTEGER, refok INTEGER DEFAULT 0, watch TEXT DEFAULT '', created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS av_seen(chat_id INTEGER, hex TEXT, ts INTEGER, PRIMARY KEY(chat_id,hex))`,
  `CREATE TABLE IF NOT EXISTS av_hist(chat_id INTEGER, ts INTEGER, hex TEXT, flight TEXT, type TEXT, dist REAL)`,
  `CREATE INDEX IF NOT EXISTS av_hist_i ON av_hist(chat_id, ts)`,
  `CREATE TABLE IF NOT EXISTS av_cells(k TEXT PRIMARY KEY, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS av_photo(hex TEXT PRIMARY KEY, url TEXT, credit TEXT, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS av_pend(hex TEXT PRIMARY KEY, first INTEGER)`,
];
async function multi(env, table, cols, rows, tail) {
  const per = Math.max(1, Math.floor(90 / cols.length));
  for (let i = 0; i < rows.length; i += per) {
    const ch = rows.slice(i, i + per);
    const sql = `INSERT INTO ${table}(${cols.join(',')}) VALUES ${ch.map(() => '(' + cols.map(() => '?').join(',') + ')').join(',')} ${tail || ''}`;
    await env.DB.prepare(sql).bind(...ch.flat()).run();
  }
}
const getUser = (env, id) => env.DB.prepare('SELECT * FROM av_users WHERE chat_id=?').bind(id).first();
async function setUser(env, id, f) {
  const k = Object.keys(f);
  if (!k.length) return;
  await env.DB.prepare(`UPDATE av_users SET ${k.map(x => x + '=?').join(',')} WHERE chat_id=?`).bind(...k.map(x => f[x]), id).run();
}

// ---------- ADS-B ----------
async function getAircraft(lat, lon, B, off) {
  const urls = [
    `https://api.adsb.lol/v2/point/${lat}/${lon}/${NM}`,
    `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${NM}`,
    `https://api.airplanes.live/v2/point/${lat}/${lon}/${NM}`,
  ];
  for (let i = 0; i < 3; i++) {
    if (B.n >= TOTAL_BUDGET - 10) break;
    B.n++;
    try {
      const r = await fetch(urls[(i + off) % 3], { headers: { 'user-agent': 'flight-checker-telegram-bot' } });
      if (!r.ok) continue;
      const j = await r.json();
      const ac = j.ac || j.aircraft;
      if (Array.isArray(ac)) return ac;
    } catch (e) { /* try next source */ }
  }
  return null;
}
async function photoLookup(hex, B) {
  B.n++;
  try {
    const r = await fetch(`https://api.planespotters.net/pub/photos/hex/${hex}`, { headers: { 'user-agent': 'flight-checker-telegram-bot' } });
    if (!r.ok) return { url: '', credit: '' };
    const j = await r.json();
    const p = j.photos && j.photos[0];
    if (!p) return { url: '', credit: '' };
    return { url: (p.thumbnail_large && p.thumbnail_large.src) || (p.thumbnail && p.thumbnail.src) || '', credit: p.photographer || '' };
  } catch (e) { return { url: '', credit: '' }; }
}

// ---------- cron ----------
async function tick(env) {
  const t0 = Date.now(), now = nowS(), B = { n: 0 };
  const users = (await env.DB.prepare('SELECT * FROM av_users WHERE active=1 AND sub=1 AND lat IS NOT NULL').all()).results;
  if (!users.length) return;
  const cells = new Map();
  for (const u of users) {
    const k = Math.floor(u.lat) + ':' + Math.floor(u.lon);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(u);
  }
  const last = new Map((await env.DB.prepare('SELECT k,ts FROM av_cells').all()).results.map(r => [r.k, r.ts]));
  const order = [...cells.keys()].sort((a, b) => (last.get(a) || 0) - (last.get(b) || 0));
  const seen = new Set((await env.DB.prepare('SELECT chat_id,hex FROM av_seen WHERE ts>?').bind(now - COOLDOWN).all()).results.map(r => r.chat_id + '|' + r.hex));
  const pend = new Map((await env.DB.prepare('SELECT hex,first FROM av_pend').all()).results.map(r => [r.hex, r.first]));
  const cand = [], done = [], newPend = [];
  let ci = 0;
  for (const k of order) {
    if (B.n >= FETCH_BUDGET || Date.now() - t0 > WALL_MS) break;
    const [la, lo] = k.split(':').map(Number);
    const ac = await getAircraft(la + 0.5, lo + 0.5, B, ci++ % 3);
    if (!ac) { await sleep(1100); continue; }
    done.push([k, now]);
    const us = cells.get(k);
    for (const a of ac) {
      if (a.lat == null || a.lon == null || a.alt_baro === 'ground' || !a.hex || (a.seen_pos != null && a.seen_pos > 60)) continue;
      const hex = a.hex.toLowerCase(), sq = a.squawk;
      const emg = sq === '7500' || sq === '7600' || sq === '7700';
      let emgOk = false;
      if (emg) {
        if (sq === '7500') {
          const f = pend.get(hex);
          if (!f) { pend.set(hex, now); newPend.push([hex, now]); } else if (now - f >= 30) emgOk = true;
        } else emgOk = true;
      }
      for (const u of us) {
        const d = km(u.lat, u.lon, a.lat, a.lon);
        if (d > u.radius || seen.has(u.chat_id + '|' + hex)) continue;
        let kind = null;
        if (emgOk && u.emerg) kind = 'emg';
        else if (isQuiet(u, now)) continue;
        else if (watchMatch(u, a)) kind = 'watch';
        else if (u.mode === 'all' && passFilters(u, a)) kind = isRare(a) ? 'rare' : 'norm';
        else if (u.mode === 'rare' && passFilters(u, a) && isRare(a)) kind = 'rare';
        if (!kind) continue;
        const g = geoOk(u, a, d);
        if (!g.ok && kind !== 'emg') continue;
        cand.push({ u, a, d, hex, kind, cp: g.c, brg: bearing(u.lat, u.lon, a.lat, a.lon), prio: { emg: 0, watch: 1, rare: 2, norm: 3 }[kind] });
      }
    }
    await sleep(1100);
  }

  // per-user cap, priority order
  cand.sort((x, y) => x.prio - y.prio || x.d - y.d);
  const cnt = new Map(), out = [];
  for (const c of cand) {
    const n = cnt.get(c.u.chat_id) || 0;
    if (n >= MAX_PER_USER && c.kind !== 'emg') continue;
    cnt.set(c.u.chat_id, n + 1);
    out.push(c);
  }

  // photos (cached in D1)
  const photo = new Map();
  if (out.length) {
    const hexes = [...new Set(out.map(c => c.hex))].slice(0, 80);
    const rows = (await env.DB.prepare(`SELECT hex,url,credit FROM av_photo WHERE hex IN (${hexes.map(() => '?').join(',')})`).bind(...hexes).all()).results;
    for (const r of rows) photo.set(r.hex, r);
    const miss = hexes.filter(h => !photo.has(h)).slice(0, 4);
    if (miss.length && B.n < TOTAL_BUDGET - 12) {
      const res = await Promise.all(miss.map(h => photoLookup(h, B)));
      const ins = [];
      miss.forEach((h, i) => { photo.set(h, res[i]); ins.push([h, res[i].url, res[i].credit, now]); });
      await multi(env, 'av_photo', ['hex', 'url', 'credit', 'ts'], ins, 'ON CONFLICT(hex) DO UPDATE SET url=excluded.url,credit=excluded.credit,ts=excluded.ts');
    }
  }

  // send
  const sentRows = [], hist = [], blocked = new Set();
  const room = Math.max(0, TOTAL_BUDGET - B.n - 2);
  const list = out.slice(0, room);
  for (let i = 0; i < list.length; i += 10) {
    await Promise.all(list.slice(i, i + 10).map(async c => {
      const lang = c.u.lang === 'ru' ? 'ru' : 'en', L = T[lang];
      let text = buildAlert(c, L, lang);
      const p = photo.get(c.hex);
      if (p && p.url && p.credit) text += `\n<i>${L.photo}: ${esc(p.credit)} / planespotters.net</i>`;
      const kb = { inline_keyboard: [[{ text: L.map, url: `https://globe.airplanes.live/?icao=${c.hex}` }]] };
      let r;
      if (p && p.url) {
        r = await tg(env, 'sendPhoto', { chat_id: c.u.chat_id, photo: p.url, caption: text, parse_mode: 'HTML', reply_markup: kb }, B);
        if (!r.ok && r.error_code !== 403) r = await tg(env, 'sendMessage', { chat_id: c.u.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb }, B);
      } else r = await tg(env, 'sendMessage', { chat_id: c.u.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb }, B);
      if (r.ok) {
        sentRows.push([c.u.chat_id, c.hex, now]);
        hist.push([c.u.chat_id, now, c.hex, (c.a.flight || '').trim(), c.a.t || '', Math.round(c.d * 10) / 10]);
      } else if (r.error_code === 403) blocked.add(c.u.chat_id);
    }));
  }

  // save state
  if (sentRows.length) {
    await multi(env, 'av_seen', ['chat_id', 'hex', 'ts'], sentRows, 'ON CONFLICT(chat_id,hex) DO UPDATE SET ts=excluded.ts');
    await multi(env, 'av_hist', ['chat_id', 'ts', 'hex', 'flight', 'type', 'dist'], hist, '');
  }
  if (done.length) await multi(env, 'av_cells', ['k', 'ts'], done, 'ON CONFLICT(k) DO UPDATE SET ts=excluded.ts');
  if (newPend.length) await multi(env, 'av_pend', ['hex', 'first'], newPend, 'ON CONFLICT(hex) DO NOTHING');
  if (blocked.size) {
    const ids = [...blocked];
    await env.DB.prepare(`UPDATE av_users SET active=0 WHERE chat_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  }

  // re-check subscriptions of a few users per run
  if (B.n < TOTAL_BUDGET - 6) {
    const old = (await env.DB.prepare('SELECT chat_id FROM av_users WHERE sub=1 AND checked<? ORDER BY checked LIMIT 4').bind(now - 86400).all()).results;
    for (const r of old) {
      const ok = await isMember(env, r.chat_id);
      B.n++;
      await setUser(env, r.chat_id, ok ? { checked: now } : { sub: 0, checked: now });
    }
  }
  if (new Date().getUTCMinutes() === 0) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM av_seen WHERE ts<?').bind(now - 86400),
      env.DB.prepare('DELETE FROM av_hist WHERE ts<?').bind(now - 7 * 86400),
      env.DB.prepare('DELETE FROM av_pend WHERE first<?').bind(now - 600),
    ]);
  }
}

// ---------- menus ----------
function sub(env) {
  const ch = (env.CHANNEL || '@flight_checker').replace('@', '');
  return `https://t.me/${ch}`;
}
const POPULAR = ['A380', 'B777', 'B737', 'B767', 'B787', 'B747', 'A320', 'A330', 'A340', 'A350', 'IL76', 'IL96', 'C17'];
function menuKb(u, L) {
  const q = ['off', '23–07', '00–08', '22–08'][u.quiet | 0];
  const typ = { all: L.all, planes: L.planes, helis: L.helis }[u.type];
  const mode = { all: L.all, rare: L.rare, list: L.list }[u.mode];
  const alt = u.maxalt ? `≤ ${u.maxalt / 1000} km` : L.any;
  return {
    inline_keyboard: [
      [{ text: `${L.radius}: ${u.radius}`, callback_data: 's:r' }, { text: `${L.altBtn}: ${alt}`, callback_data: 's:a' }],
      [{ text: `${L.type}: ${typ}`, callback_data: 's:t' }, { text: `${L.mode}: ${mode}`, callback_data: 's:m' }],
      [{ text: `${L.emerg}: ${u.emerg ? L.on : L.off}`, callback_data: 'e' }, { text: `${L.notif}: ${u.active ? L.on : L.off}`, callback_data: 'p' }],
      [{ text: `${L.quiet}: ${q}`, callback_data: 'q' }, { text: `${L.tz}: UTC${u.tz >= 0 ? '+' : ''}${u.tz}`, callback_data: 'z' }],
      [{ text: L.lang, callback_data: 'l' }, { text: L.hist, callback_data: 'h' }, { text: L.watch, callback_data: 's:w' }, { text: L.ref, callback_data: 'f' }],
      [{ text: L.newLoc, callback_data: 'loc' }],
    ],
  };
}
function subView(kind, u, L) {
  const on = (c, t, d) => ({ text: (c ? '✅ ' : '') + t, callback_data: d });
  const back = [{ text: L.back, callback_data: 'menu' }];
  if (kind === 'r') return { text: L.radius, kb: [[10, 20, 30, 40, 50].map(v => on(u.radius === v, String(v), 'r:' + v)), back] };
  if (kind === 'a') return { text: L.altBtn, kb: [[[1000, '1 km'], [3000, '3 km'], [6000, '6 km'], [0, L.any]].map(([v, t]) => on(u.maxalt === v, t, 'a:' + v)), back] };
  if (kind === 't') return { text: L.type, kb: [[['all', L.all], ['planes', L.planes], ['helis', L.helis]].map(([v, t]) => on(u.type === v, t, 't:' + v)), back] };
  if (kind === 'm') return { text: L.mode, kb: [[['all', L.all], ['rare', L.rare], ['list', L.list]].map(([v, t]) => on(u.mode === v, t, 'm:' + v)), back] };
  // watchlist picker
  const cur = u.watch ? u.watch.split(',').filter(Boolean) : [];
  const rows = [];
  for (let i = 0; i < POPULAR.length; i += 4) rows.push(POPULAR.slice(i, i + 4).map(x => on(cur.includes(x), x, 'wt:' + x)));
  rows.push([on(u.mode === 'list', L.list, 'm:list')]);
  rows.push(back);
  return { text: L.watchHelp + (cur.join(', ') || L.empty), kb: rows };
}
async function showSub(env, u, kind, edit) {
  const L = T[langOf(u)], v = subView(kind, u, L);
  const body = { text: v.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: v.kb } };
  if (edit) {
    const r = await tg(env, 'editMessageText', { chat_id: edit.chat, message_id: edit.id, ...body });
    if (r.ok || /not modified/.test(r.description || '')) return;
  }
  await send(env, u.chat_id, v.text, { reply_markup: body.reply_markup });
}
const menuText = (u, L) => `${L.menu}\n📍 ${u.lat.toFixed(3)}, ${u.lon.toFixed(3)}`;
const langOf = u => (u && u.lang === 'ru' ? 'ru' : 'en');

async function showMenu(env, u, edit) {
  const L = T[langOf(u)];
  if (edit) {
    const r = await tg(env, 'editMessageText', { chat_id: edit.chat, message_id: edit.id, text: menuText(u, L), parse_mode: 'HTML', reply_markup: menuKb(u, L) });
    if (r.ok || /not modified/.test(r.description || '')) return;
  }
  await send(env, u.chat_id, menuText(u, L), { reply_markup: menuKb(u, L) });
}
async function askLoc(env, u, welcome) {
  const L = T[langOf(u)];
  await send(env, u.chat_id, welcome ? WELCOME : L.askLoc, {
    reply_markup: { keyboard: [[{ text: L.locBtn, request_location: true }]], resize_keyboard: true },
  });
}
async function askSub(env, u) {
  const L = T[langOf(u)];
  await send(env, u.chat_id, L.sub, { reply_markup: { inline_keyboard: [[{ text: L.subBtn, url: sub(env) }], [{ text: L.done, callback_data: 'chk' }]] } });
}
// returns user if subscribed, otherwise asks to subscribe
async function gate(env, u) {
  const ok = await isMember(env, u.chat_id);
  const now = nowS();
  if (ok && !u.sub) {
    await setUser(env, u.chat_id, { sub: 1, checked: now });
    u.sub = 1;
    if (u.ref) await setUser(env, u.chat_id, { refok: 1 });
  } else if (!ok) {
    if (u.sub) await setUser(env, u.chat_id, { sub: 0 });
    await askSub(env, u);
    return false;
  }
  return true;
}
async function afterSub(env, u) {
  if (u.lat == null) return askLoc(env, u, true);
  await setUser(env, u.chat_id, { active: 1 });
  u.active = 1;
  return showMenu(env, u);
}

let BOTNAME = '';
async function botName(env) {
  if (!BOTNAME) { const r = await tg(env, 'getMe'); BOTNAME = r.ok ? r.result.username : ''; }
  return BOTNAME;
}

// ---------- updates ----------
async function onMessage(env, m) {
  if (m.chat.type !== 'private') return;
  const id = m.chat.id, text = (m.text || '').trim();
  let u = await getUser(env, id);
  if (!u) {
    const lc = (m.from && m.from.language_code || '').slice(0, 2);
    const lang = ['ru', 'uk', 'be', 'ky', 'kk', 'uz', 'tg'].includes(lc) ? 'ru' : 'en';
    const mm = /^\/start r(\d+)/.exec(text);
    const ref = mm && +mm[1] !== id ? +mm[1] : null;
    await env.DB.prepare('INSERT OR IGNORE INTO av_users(chat_id,lang,ref,created) VALUES(?,?,?,?)').bind(id, lang, ref, nowS()).run();
    u = await getUser(env, id);
  }
  const L = T[langOf(u)];
  const cmd = text.startsWith('/') ? text.split(/[\s@]/)[0].toLowerCase() : '';

  if (cmd === '/id') return send(env, id, `ID: <code>${id}</code>`);
  if (cmd === '/stats' && String(id) === String(env.ADMIN_ID)) {
    const g = async s => (await env.DB.prepare(s).first()).c;
    return send(env, id, `users: ${await g('SELECT COUNT(*) c FROM av_users')}\nsubscribed: ${await g('SELECT COUNT(*) c FROM av_users WHERE sub=1')}\nactive with location: ${await g('SELECT COUNT(*) c FROM av_users WHERE sub=1 AND active=1 AND lat IS NOT NULL')}\ncells: ${await g("SELECT COUNT(DISTINCT CAST(lat AS INT)||':'||CAST(lon AS INT)) c FROM av_users WHERE sub=1 AND active=1 AND lat IS NOT NULL")}\nalerts 24h: ${await g('SELECT COUNT(*) c FROM av_hist WHERE ts>' + (nowS() - 86400))}`);
  }
  if (cmd === '/help') return send(env, id, L.help);

  if (cmd === '/start') {
    if (!(await gate(env, u))) return;
    return afterSub(env, u);
  }
  if (!(await gate(env, u))) return;

  let loc = m.location ? { latitude: m.location.latitude, longitude: m.location.longitude } : null;
  if (!loc && !cmd) { // coordinates typed as text: "42.87, 74.59"
    const mc = /(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)/.exec(text);
    if (mc && Math.abs(+mc[1]) <= 90 && Math.abs(+mc[2]) <= 180) loc = { latitude: +mc[1], longitude: +mc[2] };
  }
  if (loc) {
    await setUser(env, id, { lat: loc.latitude, lon: loc.longitude, active: 1 });
    u.lat = loc.latitude; u.lon = loc.longitude; u.active = 1;
    await send(env, id, L.locOk, { reply_markup: { remove_keyboard: true } });
    return showMenu(env, u);
  }
  if (cmd === '/location') return askLoc(env, u, false);
  if (cmd === '/stop') { await setUser(env, id, { active: 0 }); return send(env, id, L.stopped); }
  if (u.lat == null && cmd) return askLoc(env, u, false);
  if (cmd === '/settings' || cmd === '/radius') return showMenu(env, u);
  if (cmd === '/tz') {
    const v = parseInt(text.split(/\s+/)[1], 10);
    if (isNaN(v) || v < -12 || v > 14) return send(env, id, L.tzMenu);
    await setUser(env, id, { tz: v });
    return send(env, id, L.tzSet + (v >= 0 ? '+' : '') + v);
  }
  if (cmd === '/watch' || cmd === '/unwatch') {
    const items = text.split(/[\s,]+/).slice(1).map(s => s.toUpperCase());
    let cur = u.watch ? u.watch.split(',').filter(Boolean) : [];
    if (!items.length) return send(env, id, L.watchHelp + (cur.join(', ') || L.empty));
    for (const w of items) {
      if (cmd === '/unwatch') cur = cur.filter(x => x !== w);
      else {
        if (!/^[A-Z0-9-]{3,12}$/.test(w)) return send(env, id, L.watchBad);
        if (!cur.includes(w)) { if (cur.length >= 10) return send(env, id, L.watchFull); cur.push(w); }
      }
    }
    await setUser(env, id, { watch: cur.join(',') });
    return send(env, id, L.watchAdded + (cur.join(', ') || L.empty));
  }
  if (cmd === '/debug') return debugInfo(env, u);
  if (cmd === '/log') return showLog(env, u);
  if (cmd === '/ref') return showRef(env, u);
  if (!cmd) return u.lat == null ? askLoc(env, u, false) : send(env, id, L.help);
}

async function debugInfo(env, u) {
  const now = nowS();
  const k = Math.floor(u.lat) + ':' + Math.floor(u.lon);
  const c = await env.DB.prepare('SELECT ts FROM av_cells WHERE k=?').bind(k).first();
  const lines = [
    `radius ${u.radius} km, maxalt ${u.maxalt}, type ${u.type}, mode ${u.mode}, active ${u.active}, sub ${u.sub}, quiet ${u.quiet} (now quiet: ${isQuiet(u, now)}), tz ${u.tz}`,
    `watch: ${u.watch || '-'}`,
    `cell ${k}: ${c ? 'last cron update ' + (now - c.ts) + ' s ago' : 'NEVER updated by cron'}`,
  ];
  const urls = [
    ['adsb.lol', `https://api.adsb.lol/v2/point/${u.lat}/${u.lon}/${NM}`],
    ['adsb.fi', `https://opendata.adsb.fi/api/v3/lat/${u.lat}/lon/${u.lon}/dist/${NM}`],
    ['airplanes.live', `https://api.airplanes.live/v2/point/${u.lat}/${u.lon}/${NM}`],
  ];
  let best = null;
  for (const [n, url] of urls) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'flight-checker-telegram-bot' } });
      if (!r.ok) { lines.push(`${n}: HTTP ${r.status}`); continue; }
      const j = await r.json();
      const ac = j.ac || j.aircraft || [];
      lines.push(`${n}: OK, ${ac.length} aircraft within ${NM} nm`);
      if (!best) best = ac;
    } catch (e) { lines.push(`${n}: error ${String(e).slice(0, 60)}`); }
  }
  if (best) {
    const near = best.filter(a => a.lat != null && a.lon != null).map(a => ({ a, d: km(u.lat, u.lon, a.lat, a.lon) })).sort((x, y) => x.d - y.d).slice(0, 5);
    for (const { a, d } of near) lines.push(`• ${(a.flight || '').trim() || '-'} ${a.t || '?'} ${a.r || ''} ${d.toFixed(0)} km, alt ${a.alt_baro}, gs ${a.gs}, seen_pos ${a.seen_pos}`);
  }
  return send(env, u.chat_id, '<pre>' + esc(lines.join('\n')) + '</pre>');
}

async function showLog(env, u) {
  const L = T[langOf(u)];
  const rows = (await env.DB.prepare('SELECT ts,flight,type,dist FROM av_hist WHERE chat_id=? ORDER BY ts DESC LIMIT 10').bind(u.chat_id).all()).results;
  if (!rows.length) return send(env, u.chat_id, L.logEmpty);
  const lines = rows.map(r => {
    const d = new Date((r.ts + (u.tz | 0) * 3600) * 1000);
    return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} · ${esc(r.flight || '—')} · ${esc(r.type || '?')} · ${r.dist} km`;
  });
  return send(env, u.chat_id, L.logHead + lines.join('\n'));
}
async function showRef(env, u) {
  const L = T[langOf(u)];
  const n = (await env.DB.prepare('SELECT COUNT(*) c FROM av_users WHERE ref=? AND refok=1').bind(u.chat_id).first()).c;
  return send(env, u.chat_id, L.refText(`https://t.me/${await botName(env)}?start=r${u.chat_id}`, n));
}

async function onCallback(env, cb) {
  const id = cb.from.id, d = cb.data || '', msg = cb.message;
  const ans = (t, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: t, show_alert: !!alert });
  let u = await getUser(env, id);
  if (!u) { await ans(); return; }
  const L = T[langOf(u)];
  if (d === 'noop') return ans();
  if (d === 'chk') {
    if (!(await isMember(env, id))) return ans(L.nosub, true);
    await setUser(env, id, { sub: 1, checked: nowS() });
    if (u.ref) await setUser(env, id, { refok: 1 });
    u.sub = 1;
    await ans();
    return afterSub(env, u);
  }
  if (!(await isMember(env, id))) { await ans(); return askSub(env, u); }
  const edit = msg ? { chat: msg.chat.id, id: msg.message_id } : null;
  const [k, v] = d.split(':');
  const f = {};
  if (k === 'r' && [10, 20, 30, 40, 50].includes(+v)) f.radius = +v;
  else if (k === 'a' && [0, 1000, 3000, 6000].includes(+v)) f.maxalt = +v;
  else if (k === 't' && ['all', 'planes', 'helis'].includes(v)) f.type = v;
  else if (k === 'm' && ['all', 'rare', 'list'].includes(v)) f.mode = v;
  else if (d === 'e') f.emerg = u.emerg ? 0 : 1;
  else if (d === 'p') f.active = u.active ? 0 : 1;
  else if (d === 'q') f.quiet = ((u.quiet | 0) + 1) % 4;
  else if (d === 'l') f.lang = langOf(u) === 'ru' ? 'en' : 'ru';
  else if (k === 'tz' && Number.isInteger(+v)) f.tz = +v;
  else if (k === 'wt' && /^[A-Z0-9]{3,12}$/.test(v)) {
    let cur = u.watch ? u.watch.split(',').filter(Boolean) : [];
    if (cur.includes(v)) cur = cur.filter(x => x !== v);
    else if (cur.length >= 10) return ans(L.watchFull, true);
    else cur.push(v);
    await setUser(env, id, { watch: cur.join(',') });
    u.watch = cur.join(',');
    await ans();
    return showSub(env, u, 'w', edit);
  }
  if (Object.keys(f).length) {
    await setUser(env, id, f);
    Object.assign(u, f);
    await ans();
    return showMenu(env, u, edit);
  }
  await ans();
  if (k === 's' && ['r', 'a', 't', 'm', 'w'].includes(v)) return showSub(env, u, v, edit);
  if (d === 'menu') return showMenu(env, u, edit);
  if (d === 'z') {
    const row = a => a.map(x => ({ text: (u.tz === x ? '✅ ' : '') + (x >= 0 ? '+' : '') + x, callback_data: 'tz:' + x }));
    return send(env, id, L.tzMenu, { reply_markup: { inline_keyboard: [row([0, 1, 2, 3]), row([4, 5, 6, 7]), row([8, 9, 10, 11])] } });
  }
  if (d === 'h') return showLog(env, u);
  if (d === 'f') return showRef(env, u);
  if (d === 'loc') return askLoc(env, u, false);
}

async function hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/setup') {
      if (url.searchParams.get('key') !== (env.SETUP_KEY || '')) return new Response('forbidden', { status: 403 });
      await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
      const secret = (await hex(env.BOT_TOKEN)).slice(0, 32);
      const w = await tg(env, 'setWebhook', { url: url.origin + '/hook', secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      const cm = await tg(env, 'setMyCommands', { commands: [
        { command: 'start', description: 'Start / Старт' }, { command: 'settings', description: 'Settings / Настройки' },
        { command: 'location', description: 'Location / Локация' }, { command: 'watch', description: 'Watchlist / Список слежения' },
        { command: 'log', description: 'History / История' }, { command: 'ref', description: 'Invite / Пригласить' },
        { command: 'stop', description: 'Alerts off / Выключить' }, { command: 'help', description: 'Help / Помощь' },
      ] });
      return new Response(JSON.stringify({ webhook: w, commands: cm }, null, 2));
    }
    if (url.pathname === '/hook' && req.method === 'POST') {
      const secret = (await hex(env.BOT_TOKEN)).slice(0, 32);
      if (req.headers.get('x-telegram-bot-api-secret-token') !== secret) return new Response('no', { status: 403 });
      const upd = await req.json();
      ctx.waitUntil((async () => {
        try {
          if (upd.callback_query) await onCallback(env, upd.callback_query);
          else if (upd.message) await onMessage(env, upd.message);
        } catch (e) { console.error('update error', e && e.stack || e); }
      })());
      return new Response('ok');
    }
    return new Response('Flight Checker bot is running');
  },
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(tick(env).catch(e => console.error('tick error', e && e.stack || e)));
  },
};

export const _t = { km, bearing, cpa, geoOk, watchMatch, passFilters, isQuiet, buildAlert, T, isHeli, isRare, tick, onMessage, onCallback, SCHEMA };

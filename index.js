const TG_TOKEN    = process.env.TG_TOKEN    || '8628262327:AAF-kC9OrUuhT4KxW3emnZgxUrDa2qUnNiQ';
const CDEK_ID     = process.env.CDEK_ID     || 'YtqLpsCw3XjNX0hs43XbTftU9uLgkRoS';
const CDEK_SECRET = process.env.CDEK_SECRET || 'sCcpvnrv1jsJM8vexr1Vqm3Q8NW2fmw5';
const YANDEX_KEY  = process.env.YANDEX_KEY  || '214f0319-065e-42df-b2f8-94abecea1453';
const CDEK_BASE   = 'https://api.cdek.ru/v2';
const TG_BASE     = `https://api.telegram.org/bot${TG_TOKEN}`;

const SENDER = {
  name: 'Ункуца Лилия Алексеевна',
  company: 'ИП Ункуца Лилия Алексеевна',
  phones: [{ number: '+79998311989' }]
};

let cdekToken = null, cdekTokenExp = 0;
const sessions = {};

// ── CDEK ──────────────────────────────────────────────────────────────────────

async function getCdekToken() {
  if (cdekToken && Date.now() < cdekTokenExp) return cdekToken;
  const r = await fetch(`${CDEK_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${CDEK_ID}&client_secret=${CDEK_SECRET}`
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('СДЭК auth: ' + JSON.stringify(d));
  cdekToken    = d.access_token;
  cdekTokenExp = Date.now() + (d.expires_in - 60) * 1000;
  return cdekToken;
}

async function findCity(cityName) {
  const tok = await getCdekToken();
  const r = await fetch(`${CDEK_BASE}/location/cities?city=${encodeURIComponent(cityName)}&country_codes=RU&size=3`, {
    headers: { Authorization: 'Bearer ' + tok }
  });
  const d = await r.json();
  return Array.isArray(d) && d.length ? d[0] : null;
}

async function findAllPvz(cityCode) {
  const tok = await getCdekToken();
  const r = await fetch(`${CDEK_BASE}/deliverypoints?city_code=${cityCode}&type=PVZ&size=50`, {
    headers: { Authorization: 'Bearer ' + tok }
  });
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}

async function geocode(address) {
  const url = `https://geocode-maps.yandex.ru/1.x/?apikey=${YANDEX_KEY}&format=json&geocode=${encodeURIComponent(address)}&results=1`;
  const r = await fetch(url);
  const d = await r.json();
  const pos = d?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject?.Point?.pos;
  if (!pos) return null;
  const [lon, lat] = pos.split(' ').map(Number);
  return { lat, lon };
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function findNearestPvz(cityCode, fullAddress) {
  const pvzList = await findAllPvz(cityCode);
  if (!pvzList.length) return null;
  const coords = await geocode(fullAddress).catch(() => null);
  if (!coords) return pvzList[0];
  const withDist = pvzList
    .filter(p => p.location?.latitude && p.location?.longitude)
    .map(p => ({
      ...p,
      dist: distanceKm(coords.lat, coords.lon, p.location.latitude, p.location.longitude)
    }))
    .sort((a, b) => a.dist - b.dist);
  return withDist[0] || pvzList[0];
}

async function createCdekOrder(session) {
  const tok = await getCdekToken();
  let ph = session.phone.replace(/\D/g, '');
  if (ph.startsWith('8')) ph = '7' + ph.slice(1);
  if (!ph.startsWith('7')) ph = '7' + ph;
  ph = '+' + ph;

  const body = {
    type: 2,
    tariff_code: 136,
    shipment_point: 'SPB4',
    delivery_point: session.pvzCode,
    sender: SENDER,
    recipient: { name: session.name, phones: [{ number: ph }] },
    packages: [{
      number: 'PKG-' + Date.now(),
      weight: 300, length: 20, width: 20, height: 10,
      comment: 'Ножницы маникюрные',
      items: [{
        name: 'Ножницы маникюрные',
        ware_key: 'NM-001',
        payment: { value: 0 },
        cost: 100, weight: 300, amount: 1
      }]
    }]
  };

  const r = await fetch(`${CDEK_BASE}/orders`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return await r.json();
}

// ── PARSE ─────────────────────────────────────────────────────────────────────

function parseOrder(text) {
  // Normalize: replace multiple spaces with single, keep newlines
  const normalized = text.replace(/[ \t]+/g, ' ');
  const lines = normalized.split('\n').map(l => l.trim()).filter(Boolean);
  // Also split by long runs that contain address-like content (everything in one line)
  const allText = normalized;

  // ── Phone ──
  const pm = allText.match(/(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/);
  let phone = pm ? pm[0].replace(/\D/g, '') : '';
  if (phone.startsWith('8')) phone = '7' + phone.slice(1);

  // ── Name ──
  // Strategy: find 2-3 consecutive Cyrillic capitalized words NOT preceded/followed by address keywords
  // Works for both multiline and single-line formats
  let name = '';

  // Try line by line first
  for (const line of lines) {
    if (/\d|http|@|\(|₽|руб|—/i.test(line)) continue;
    const words = line.split(/\s+/);
    if (words.length < 2 || words.length > 4) continue;
    if (words.every(w => /^[А-ЯЁ][а-яёА-ЯЁ\-]+$/.test(w) && w.length > 1)) {
      name = line;
      break;
    }
  }

  // If not found line by line — scan for FIO pattern in full text
  // Pattern: 3 capitalized Cyrillic words in a row (Фамилия Имя Отчество)
  if (!name) {
    const fioMatch = allText.match(/([А-ЯЁ][а-яё]+)\s+([А-ЯЁ][а-яё]+)\s+([А-ЯЁ][а-яё]+)/);
    if (fioMatch) {
      // Make sure these are not city/region words
      const skip = /область|район|край|город|улица|проспект|переулок/i;
      if (!skip.test(fioMatch[0])) {
        name = fioMatch[0];
      }
    }
  }

  // ── City ──
  let city = '';

  // Pattern: explicit marker г. с. пос. город
  const cityMarker = allText.match(/(?:^|[\s,])(?:г\.|город\s+|с\.\s*|пос\.\s*|пгт\.\s*)([А-ЯЁ][а-яё\-]+(?:\s[А-ЯЁ][а-яё\-]+)?)/im);
  if (cityMarker) city = cityMarker[1].trim();

  // Pattern: after postal code — last city-like token
  if (!city) {
    const postalM = allText.match(/\d{6}\s+([^\n\d]+)/);
    if (postalM) {
      const parts = postalM[1].split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      const skip = /^(область|обл|край|район|р-н|округ|ул|улица|пр|проспект|пер|переулок|наб|бул|шоссе|дом|д|кв|квартира)\.?$/i;
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (/^[А-ЯЁ][а-яё\-]+$/.test(p) && p.length > 2 && !skip.test(p)) {
          city = p; break;
        }
      }
    }
  }

  // Pattern: word after region keywords
  if (!city) {
    const regionRx = /(?:край|область|обл\b|район|р-н|округ)\s+([А-ЯЁ][а-яё\-]+)/i;
    const rm = allText.match(regionRx);
    if (rm) city = rm[1];
  }

  // ── Street ──
  let street = '';
  const streetRx = [
    /(?:ул\.?\s*|улица\s+)([А-ЯЁа-яё\s\-]+?)\s*(?:д\.?\s*|дом\s*)?(\d+[\w\/\-]*)/i,
    /(?:пр\.?\s*|проспект\s+)([А-ЯЁа-яё\s\-]+?)\s*(?:д\.?\s*|дом\s*)?(\d+[\w\/\-]*)/i,
    /(?:пер\.?\s*|переулок\s+)([А-ЯЁа-яё\s\-]+?)\s*(?:д\.?\s*|дом\s*)?(\d+[\w\/\-]*)/i,
    /(?:наб\.?\s*|набережная\s+)([А-ЯЁа-яё\s\-]+?)\s*(?:д\.?\s*|дом\s*)?(\d+[\w\/\-]*)/i,
    /(?:бул\.?\s*|бульвар\s+)([А-ЯЁа-яё\s\-]+?)\s*(?:д\.?\s*|дом\s*)?(\d+[\w\/\-]*)/i,
    /(?:шоссе\s+)([А-ЯЁа-яё\s\-]+?)\s*(?:д\.?\s*|дом\s*)?(\d+[\w\/\-]*)/i,
  ];
  for (const rx of streetRx) {
    const m = allText.match(rx);
    if (m) { street = m[0].trim().replace(/,\s*$/, ''); break; }
  }

  return { name, phone: phone ? '+' + phone : '', city, street };
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────────

async function tg(method, body) {
  const r = await fetch(`${TG_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

function send(chatId, text, extra = {}) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

function keyboard(buttons) {
  return { reply_markup: { inline_keyboard: buttons } };
}

function summaryText(sess) {
  let t = `👤 Имя: <b>${sess.name || '❓'}</b>\n`;
  t += `📱 Телефон: <b>${sess.phone || '❓'}</b>\n`;
  t += `🏙 Город: <b>${sess.city || '❓'}</b>\n`;
  t += `🏠 Адрес: <b>${sess.street || 'не указан'}</b>`;
  return t;
}

// ── FLOW ──────────────────────────────────────────────────────────────────────

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();
  let sess     = sessions[chatId] || { step: 'wait_order' };

  // Commands always reset
  if (text === '/start' || text === '/new') {
    sessions[chatId] = { step: 'wait_order' };
    return send(chatId, '📦 <b>Новый заказ СДЭК</b>\n\nВставьте текст заказа в любом формате:');
  }

  // ── Step: wait_order ──
  if (sess.step === 'wait_order') {
    const parsed = parseOrder(text);
    sess.name   = parsed.name;
    sess.phone  = parsed.phone;
    sess.city   = parsed.city;
    sess.street = parsed.street;

    const missing = [];
    if (!sess.name)  missing.push('имя');
    if (!sess.phone) missing.push('телефон');
    if (!sess.city)  missing.push('город');

    let reply = '🔍 <b>Распознал заказ:</b>\n\n' + summaryText(sess) + '\n\n';

    if (missing.length) {
      reply += `⚠️ Не удалось определить: <b>${missing.join(', ')}</b>\n\n`;
      reply += `Напишите недостающее через запятую:\n`;
      reply += `<i>пример: Иванова Мария Петровна, 89001234567, Казань</i>`;
      sess.step = 'clarify';
      sess.missing = missing;
      sessions[chatId] = sess;
      return send(chatId, reply);
    }

    sess.step = 'confirm_data';
    sessions[chatId] = sess;
    reply += 'Всё верно?';
    return send(chatId, reply, keyboard([
      [{ text: '✅ Верно, найти ПВЗ', callback_data: 'find_pvz' }],
      [{ text: '✏️ Исправить', callback_data: 'clarify' }]
    ]));
  }

  // ── Step: clarify ──
  // User sends missing fields — parse them WITHOUT resetting existing session data
  if (sess.step === 'clarify') {
    const parts = text.split(',').map(p => p.trim()).filter(Boolean);

    for (const part of parts) {
      // Phone?
      const phoneM = part.replace(/\D/g, '');
      if (phoneM.length >= 10) {
        let ph = phoneM;
        if (ph.startsWith('8')) ph = '7' + ph.slice(1);
        if (!ph.startsWith('7')) ph = '7' + ph;
        sess.phone = '+' + ph;
        continue;
      }
      // City? (single word)
      if (/^[А-ЯЁ][а-яё\-]+(\s[А-ЯЁ][а-яё\-]+)?$/.test(part) && part.split(' ').length <= 2) {
        // If it looks like a city (1-2 words) and we're missing city
        const words = part.split(' ');
        if (words.length === 1 && !sess.city) { sess.city = part; continue; }
        if (words.length === 2 && !sess.city) { sess.city = part; continue; }
      }
      // Name? (2-4 capitalized words)
      const words = part.split(/\s+/);
      if (words.length >= 2 && words.length <= 4 && words.every(w => /^[А-ЯЁ][а-яёА-ЯЁ\-]+$/.test(w))) {
        sess.name = part;
        continue;
      }
    }

    const stillMissing = [];
    if (!sess.name)  stillMissing.push('имя');
    if (!sess.phone) stillMissing.push('телефон');
    if (!sess.city)  stillMissing.push('город');

    let reply = '🔍 <b>Данные после уточнения:</b>\n\n' + summaryText(sess) + '\n\n';

    if (stillMissing.length) {
      reply += `⚠️ Всё ещё не указано: <b>${stillMissing.join(', ')}</b>\n\n`;
      reply += `Напишите через запятую:\n<i>пример: Иванова Мария Петровна, 89001234567, Казань</i>`;
      sess.step = 'clarify';
      sessions[chatId] = sess;
      return send(chatId, reply);
    }

    sess.step = 'confirm_data';
    sessions[chatId] = sess;
    reply += 'Всё верно?';
    return send(chatId, reply, keyboard([
      [{ text: '✅ Верно, найти ПВЗ', callback_data: 'find_pvz' }],
      [{ text: '✏️ Исправить', callback_data: 'clarify' }]
    ]));
  }

  // Any other text during active session — remind user
  if (sess.step && sess.step !== 'wait_order') {
    return send(chatId, 'Используйте кнопки выше или /new для нового заказа');
  }
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const data   = cb.data;
  const sess   = sessions[chatId] || {};

  await tg('answerCallbackQuery', { callback_query_id: cb.id });

  if (data === 'clarify') {
    sess.step = 'clarify';
    sessions[chatId] = sess;
    const missing = [];
    if (!sess.name)  missing.push('имя');
    if (!sess.phone) missing.push('телефон');
    if (!sess.city)  missing.push('город');
    const hint = missing.length ? `Не хватает: <b>${missing.join(', ')}</b>\n\n` : '';
    return send(chatId, `✏️ ${hint}Напишите исправления через запятую:\n<i>пример: Иванова Мария Петровна, 89001234567, Казань</i>`);
  }

  if (data === 'find_pvz') {
    await send(chatId, '🔎 Ищу ближайший ПВЗ...');
    try {
      const city = await findCity(sess.city);
      if (!city) {
        // Ask user to clarify city, stay in clarify mode
        sess.step = 'clarify';
        sessions[chatId] = sess;
        return send(chatId, `❌ Город «${sess.city}» не найден в базе СДЭК.\n\nНапишите название города точнее:`);
      }

      sess.cityCode = city.code;
      sess.city     = city.city;
      sessions[chatId] = sess;

      const fullAddr = [sess.city, sess.street].filter(Boolean).join(', ');
      const pvz = await findNearestPvz(city.code, fullAddr);

      if (!pvz) return send(chatId, `❌ ПВЗ не найдены в городе ${city.city}.`);

      sess.pvzCode = pvz.code;
      sess.pvzName = pvz.name;
      sess.pvzAddr = pvz.location?.address || '';
      sess.pvzDist = pvz.dist ? pvz.dist.toFixed(1) + ' км' : null;
      sess.step    = 'confirm_order';
      sessions[chatId] = sess;

      let reply = '📋 <b>Итоговые данные заказа:</b>\n\n';
      reply += `👤 ${sess.name}\n`;
      reply += `📱 ${sess.phone}\n\n`;
      reply += `📍 <b>ПВЗ:</b> ${sess.pvzName}\n`;
      reply += `🏠 ${sess.pvzAddr}\n`;
      if (sess.pvzDist) reply += `📏 ${sess.pvzDist} от адреса получателя\n`;
      reply += `\n📦 Ножницы маникюрные · 100 ₽\n`;
      reply += `⚖️ 300 г · 20×20×10 см\n\nСоздать заказ?`;

      return send(chatId, reply, keyboard([
        [{ text: '🚀 Создать заказ в СДЭК', callback_data: 'create_order' }],
        [{ text: '🔄 Другой ПВЗ', callback_data: 'show_pvz_list' }],
        [{ text: '❌ Отмена', callback_data: 'cancel' }]
      ]));
    } catch(e) {
      return send(chatId, '❌ Ошибка: ' + e.message);
    }
  }

  if (data === 'show_pvz_list') {
    await send(chatId, '📍 Загружаю список ПВЗ...');
    try {
      const pvzList = await findAllPvz(sess.cityCode);
      if (!pvzList.length) return send(chatId, '❌ ПВЗ не найдены');
      sess.pvzOptions = pvzList.slice(0, 5);
      sess.step = 'select_pvz';
      sessions[chatId] = sess;
      const buttons = sess.pvzOptions.map((pvz, i) => [{
        text: `${i+1}. ${pvz.name} — ${pvz.location?.address || ''}`,
        callback_data: `pvz_${i}`
      }]);
      return send(chatId, `📍 <b>ПВЗ в городе ${sess.city}:</b>`, keyboard(buttons));
    } catch(e) {
      return send(chatId, '❌ Ошибка: ' + e.message);
    }
  }

  if (data.startsWith('pvz_')) {
    const idx = parseInt(data.split('_')[1]);
    const pvz = sess.pvzOptions?.[idx];
    if (!pvz) return send(chatId, 'Ошибка — попробуйте /new');
    sess.pvzCode = pvz.code;
    sess.pvzName = pvz.name;
    sess.pvzAddr = pvz.location?.address || '';
    sess.pvzDist = null;
    sess.step    = 'confirm_order';
    sessions[chatId] = sess;

    let reply = '📋 <b>Итоговые данные заказа:</b>\n\n';
    reply += `👤 ${sess.name}\n📱 ${sess.phone}\n\n`;
    reply += `📍 <b>ПВЗ:</b> ${sess.pvzName}\n🏠 ${sess.pvzAddr}\n\n`;
    reply += `📦 Ножницы маникюрные · 100 ₽\n⚖️ 300 г · 20×20×10 см\n\nСоздать заказ?`;
    return send(chatId, reply, keyboard([
      [{ text: '🚀 Создать заказ в СДЭК', callback_data: 'create_order' }],
      [{ text: '❌ Отмена', callback_data: 'cancel' }]
    ]));
  }

  if (data === 'create_order') {
    await send(chatId, '⏳ Создаю заказ в СДЭК...');
    try {
      const result = await createCdekOrder(sess);
      if (result.entity?.uuid) {
        sessions[chatId] = { step: 'wait_order' };
        let reply = `✅ <b>Заказ создан!</b>\n\n`;
        reply += `📌 Номер СДЭК: <b>${result.entity.cdek_number || '(присваивается)'}</b>\n`;
        reply += `🔑 UUID: <code>${result.entity.uuid}</code>\n\n`;
        reply += `Для нового заказа нажмите /new`;
        return send(chatId, reply);
      } else if (result.requests?.[0]?.errors?.length) {
        const errs = result.requests[0].errors.map(e => e.message).join('\n');
        return send(chatId, '❌ Ошибка СДЭК:\n' + errs);
      } else {
        return send(chatId, '❌ Неожиданный ответ:\n' + JSON.stringify(result).slice(0, 300));
      }
    } catch(e) {
      return send(chatId, '❌ Ошибка: ' + e.message);
    }
  }

  if (data === 'cancel') {
    sessions[chatId] = { step: 'wait_order' };
    return send(chatId, 'Отменено. Для нового заказа нажмите /new');
  }
}

// ── SERVER ────────────────────────────────────────────────────────────────────

const http = require('http');

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const update = JSON.parse(body);
        if (update.message)        await handleMessage(update.message);
        if (update.callback_query) await handleCallback(update.callback_query);
      } catch(e) { console.error('Update error:', e); }
      res.writeHead(200);
      res.end('ok');
    });
  } else {
    res.writeHead(200);
    res.end('CDEK Bot running');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Bot server running on port', PORT));

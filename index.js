const TG_TOKEN    = process.env.TG_TOKEN    || '8628262327:AAF-kC9OrUuhT4KxW3emnZgxUrDa2qUnNiQ';
const CDEK_ID     = process.env.CDEK_ID     || 'YtqLpsCw3XjNX0hs43XbTftU9uLgkRoS';
const CDEK_SECRET = process.env.CDEK_SECRET || 'sCcpvnrv1jsJM8vexr1Vqm3Q8NW2fmw5';
const YANDEX_KEY  = process.env.YANDEX_KEY  || '214f0319-065e-42df-b2f8-94abecea1453';
const CDEK_BASE   = 'https://api.cdek.ru/v2';
const TG_BASE     = `https://api.telegram.org/bot${TG_TOKEN}`;

const SENDER = {
  name: 'Ункуца Лилия Алексеевна',
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

  // Try to geocode the recipient address
  const coords = await geocode(fullAddress).catch(() => null);

  if (!coords) {
    // No coords — return first PVZ
    return pvzList[0];
  }

  // Sort by distance
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
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Phone
  const pm = text.match(/(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/);
  let phone = pm ? pm[0].replace(/\D/g, '') : '';
  if (phone.startsWith('8')) phone = '7' + phone.slice(1);

  // Name: 2-4 Cyrillic words each starting with uppercase
  // Also handles mixed case like "Гуляева Елена Семёновна"
  let name = '';
  for (const line of lines) {
    if (/\d|http|@|\(|₽|руб|—|->/i.test(line)) continue;
    const words = line.split(/\s+/);
    if (words.length < 2 || words.length > 4) continue;
    // Each word: starts with capital Cyrillic, rest lowercase Cyrillic (allow ё and -)
    if (words.every(w => /^[А-ЯЁ][а-яёА-ЯЁ\-]+$/.test(w) && w.length > 1)) {
      name = line;
      break;
    }
  }

  // City
  let city = '';

  // After postal code pattern: "617220 Пермский край, Карагайский район, с. Козьмодемьянск"
  const postalLine = text.match(/\d{6}[^\n]+/);
  if (postalLine) {
    // Extract last city-like token before street keywords
    const pl = postalLine[0];
    // Look for с. г. пос. пгт.
    const cm = pl.match(/(?:с\.|г\.|пос\.|пгт\.)\s*([А-ЯЁ][а-яё\-]+)/);
    if (cm) city = cm[1];
    // Or last comma-separated segment that looks like a city
    if (!city) {
      const parts = pl.split(',').map(s => s.trim());
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i].replace(/^(с\.|г\.|пос\.|пгт\.)\s*/i, '').trim();
        if (/^[А-ЯЁ][а-яё\-]+$/.test(p) && p.length > 2) { city = p; break; }
      }
    }
  }

  if (!city) {
    const cm = text.match(/(?:^|[\s,])(?:г\.|г\s|город\s|с\.|с\s|пос\.|пгт\.)\s*([А-ЯЁ][а-яё\-]+)/m);
    if (cm) city = cm[1];
  }

  if (!city) {
    const regionRx = /край|область|обл\b|район|р-н|округ/i;
    let afterRegion = false;
    for (const line of lines) {
      if (regionRx.test(line)) { afterRegion = true; continue; }
      if (afterRegion && /^[А-ЯЁ][а-яё\-]+(\s[А-ЯЁ][а-яё\-]+)?$/.test(line)) { city = line; break; }
    }
  }

  // Street
  let street = '';
  const streetRx = [
    /(?:ул\.?\s*|улица\s+)([А-ЯЁа-яё\s\-]+?)\s*(?:д\.?\s*)?(\d+[\w\/\-]*)/i,
    /(?:пр\.?\s*|проспект\s+)([А-ЯЁа-яё\s\-]+?)\s*(?:д\.?\s*)?(\d+[\w\/\-]*)/i,
    /(?:пер\.?\s*|переулок\s+)([А-ЯЁа-яё\s\-]+?)\s*(?:д\.?\s*)?(\d+[\w\/\-]*)/i,
    /(?:наб\.?\s*|набережная\s+)([А-ЯЁа-яё\s\-]+?)\s*(?:д\.?\s*)?(\d+[\w\/\-]*)/i,
    /(?:бул\.?\s*|бульвар\s+)([А-ЯЁа-яё\s\-]+?)\s*(?:д\.?\s*)?(\d+[\w\/\-]*)/i,
    /(?:шоссе\s+)([А-ЯЁа-яё\s\-]+?)\s*(?:д\.?\s*)?(\d+[\w\/\-]*)/i,
  ];
  for (const rx of streetRx) {
    const m = text.match(rx);
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

// ── FLOW ──────────────────────────────────────────────────────────────────────

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();
  const sess   = sessions[chatId] || {};

  if (text === '/start' || text === '/new') {
    sessions[chatId] = { step: 'wait_order' };
    return send(chatId, '📦 <b>Новый заказ СДЭК</b>\n\nВставьте текст заказа в любом формате:');
  }

  if (!sess.step || sess.step === 'wait_order') {
    if (text.startsWith('/')) return send(chatId, 'Используйте /new для нового заказа');

    const parsed = parseOrder(text);
    sess.name   = parsed.name;
    sess.phone  = parsed.phone;
    sess.city   = parsed.city;
    sess.street = parsed.street;
    sess.step   = 'confirm_data';
    sessions[chatId] = sess;

    let reply = '🔍 <b>Распознал заказ:</b>\n\n';
    reply += `👤 Имя: <b>${sess.name || '❓ не найдено'}</b>\n`;
    reply += `📱 Телефон: <b>${sess.phone || '❓ не найден'}</b>\n`;
    reply += `🏙 Город: <b>${sess.city || '❓ не найден'}</b>\n`;
    reply += `🏠 Адрес: <b>${sess.street || 'не указан'}</b>\n\n`;

    const missing = [];
    if (!sess.name)  missing.push('имя');
    if (!sess.phone) missing.push('телефон');
    if (!sess.city)  missing.push('город');

    if (missing.length) {
      reply += `⚠️ Не удалось определить: <b>${missing.join(', ')}</b>\n\n`;
      reply += `Напишите недостающее через запятую:\n`;
      reply += `<i>пример: Иванова Мария Петровна, 89001234567, Казань</i>`;
      sess.step = 'clarify';
      return send(chatId, reply);
    }

    reply += 'Всё верно?';
    return send(chatId, reply, keyboard([
      [{ text: '✅ Верно, найти ПВЗ', callback_data: 'find_pvz' }],
      [{ text: '✏️ Исправить', callback_data: 'clarify' }]
    ]));
  }

  if (sess.step === 'clarify') {
    const parts = text.split(',').map(p => p.trim());
    for (const part of parts) {
      const phoneM = part.match(/[\+7|8]?[\d\s\-\(\)]{10,}/);
      if (phoneM) {
        let ph = part.replace(/\D/g, '');
        if (ph.startsWith('8')) ph = '7' + ph.slice(1);
        sess.phone = '+' + ph;
        continue;
      }
      const words = part.split(/\s+/);
      if (words.length >= 2 && words.every(w => /^[А-ЯЁ][а-яёА-ЯЁ\-]+$/.test(w))) {
        sess.name = part;
        continue;
      }
      if (/^[А-ЯЁ][а-яё\-]+(\s[А-ЯЁ][а-яё\-]+)?$/.test(part)) {
        sess.city = part;
        continue;
      }
    }

    sess.step = 'confirm_data';
    sessions[chatId] = sess;

    let reply = '🔍 <b>Данные после уточнения:</b>\n\n';
    reply += `👤 Имя: <b>${sess.name || '❓'}</b>\n`;
    reply += `📱 Телефон: <b>${sess.phone || '❓'}</b>\n`;
    reply += `🏙 Город: <b>${sess.city || '❓'}</b>\n`;
    reply += `🏠 Адрес: <b>${sess.street || 'не указан'}</b>\n\nВсё верно?`;

    return send(chatId, reply, keyboard([
      [{ text: '✅ Верно, найти ПВЗ', callback_data: 'find_pvz' }],
      [{ text: '✏️ Исправить ещё раз', callback_data: 'clarify' }]
    ]));
  }

  return send(chatId, 'Используйте /new для нового заказа');
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const data   = cb.data;
  const sess   = sessions[chatId] || {};

  await tg('answerCallbackQuery', { callback_query_id: cb.id });

  if (data === 'clarify') {
    sess.step = 'clarify';
    sessions[chatId] = sess;
    return send(chatId, '✏️ Напишите исправления через запятую:\n<i>пример: Иванова Мария Петровна, 89001234567, Казань</i>');
  }

  if (data === 'find_pvz') {
    await send(chatId, '🔎 Ищу ближайший ПВЗ...');
    try {
      const city = await findCity(sess.city);
      if (!city) return send(chatId, `❌ Город «${sess.city}» не найден в базе СДЭК.\n\nУточните название города:`);

      sess.cityCode = city.code;
      sess.city     = city.city;
      sessions[chatId] = sess;

      // Build full address for geocoding
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
      reply += `⚖️ 300 г · 20×20×10 см\n\n`;
      reply += `Создать заказ?`;

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

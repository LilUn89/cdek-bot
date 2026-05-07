const TG_TOKEN    = process.env.TG_TOKEN    || '8628262327:AAF-kC9OrUuhT4KxW3emnZgxUrDa2qUnNiQ';
const CDEK_ID     = process.env.CDEK_ID     || 'YtqLpsCw3XjNX0hs43XbTftU9uLgkRoS';
const CDEK_SECRET = process.env.CDEK_SECRET || 'sCcpvnrv1jsJM8vexr1Vqm3Q8NW2fmw5';
const CDEK_BASE   = 'https://api.cdek.ru/v2';
const TG_BASE     = `https://api.telegram.org/bot${TG_TOKEN}`;

let cdekToken = null, cdekTokenExp = 0;

// In-memory session per chat
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

async function findPvz(cityCode) {
  const tok = await getCdekToken();
  const r = await fetch(`${CDEK_BASE}/deliverypoints?city_code=${cityCode}&type=PVZ&size=5`, {
    headers: { Authorization: 'Bearer ' + tok }
  });
  const d = await r.json();
  return Array.isArray(d) ? d : [];
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
    recipient: { name: session.name, phones: [{ number: ph }] },
    packages: [{
      number: 'PKG-' + Date.now(),
      weight: 300, length: 20, width: 20, height: 10,
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
  // Phone
  const pm = text.match(/(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/);
  let phone = pm ? pm[0].replace(/\D/g, '') : '';
  if (phone.startsWith('8')) phone = '7' + phone.slice(1);

  // Name: 2-4 Cyrillic capitalized words, no digits/special
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let name = '';
  for (const line of lines) {
    if (/\d|http|@|\(|₽|руб/i.test(line)) continue;
    const words = line.split(/\s+/);
    if (words.length < 2 || words.length > 4) continue;
    if (words.every(w => /^[А-ЯЁ][а-яё\-]+$/.test(w))) { name = line; break; }
  }

  // City
  let city = '';
  // After postal code
  const postal = text.match(/\d{6}[^\n]*(?:,\s*)(?:[^,\n]+,\s*)*(?:с\.\s*|г\.\s*|пос\.\s*|пгт\.\s*)?([А-ЯЁ][а-яё\-]+)/);
  if (postal) city = postal[1];

  if (!city) {
    const cm = text.match(/(?:^|[\s,])(?:г\.|г\s|город\s|с\.|с\s|пос\.|пгт\.)\s*([А-ЯЁ][а-яё\-]+)/m);
    if (cm) city = cm[1];
  }

  if (!city) {
    const regionRx = /край|область|обл\b|район|р-н|округ/i;
    let afterRegion = false;
    for (const line of lines) {
      if (regionRx.test(line)) { afterRegion = true; continue; }
      if (afterRegion && /^[А-ЯЁ][а-яё\-]+$/.test(line)) { city = line; break; }
    }
  }

  if (!city) {
    const am = text.match(/([А-ЯЁ][а-яё\-]+)[,\s]+(?:ул\.|пр\.|пер\.|бул\.|шоссе|наб\.)/);
    if (am) city = am[1];
  }

  return { name, phone: phone ? '+' + phone : '', city };
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

  // Waiting for order text
  if (!sess.step || sess.step === 'wait_order') {
    if (text.startsWith('/')) return send(chatId, 'Используйте /new для нового заказа');

    const parsed = parseOrder(text);
    sess.name  = parsed.name;
    sess.phone = parsed.phone;
    sess.city  = parsed.city;
    sess.step  = 'confirm_data';
    sessions[chatId] = sess;

    let reply = '🔍 <b>Распознал заказ:</b>\n\n';
    reply += `👤 Имя: <b>${sess.name || '❓ не найдено'}</b>\n`;
    reply += `📱 Телефон: <b>${sess.phone || '❓ не найден'}</b>\n`;
    reply += `🏙 Город: <b>${sess.city || '❓ не найден'}</b>\n\n`;

    const missing = [];
    if (!sess.name)  missing.push('имя');
    if (!sess.phone) missing.push('телефон');
    if (!sess.city)  missing.push('город');

    if (missing.length) {
      reply += `⚠️ Не удалось определить: <b>${missing.join(', ')}</b>\n`;
      reply += `Уточните — напишите через запятую:\n`;
      reply += `<i>пример: Иванова Мария Петровна, 89001234567, Казань</i>`;
      sess.step = 'clarify';
    } else {
      reply += 'Всё верно?';
      return send(chatId, reply, keyboard([
        [{ text: '✅ Верно, найти ПВЗ', callback_data: 'find_pvz' }],
        [{ text: '✏️ Исправить', callback_data: 'clarify' }]
      ]));
    }

    return send(chatId, reply);
  }

  // Clarify missing fields
  if (sess.step === 'clarify') {
    const parts = text.split(',').map(p => p.trim());
    for (const part of parts) {
      const phoneM = part.match(/[\+7|8]?[\d\s\-\(\)]{10,}/);
      if (phoneM) { sess.phone = part.replace(/\D/g,''); if (sess.phone.startsWith('8')) sess.phone = '7'+sess.phone.slice(1); sess.phone = '+'+sess.phone; continue; }
      const cyrWords = part.split(/\s+/);
      if (cyrWords.length >= 2 && cyrWords.every(w => /^[А-ЯЁ][а-яё\-]+$/.test(w))) { sess.name = part; continue; }
      if (/^[А-ЯЁ][а-яё\-]+$/.test(part)) { sess.city = part; continue; }
    }

    sess.step = 'confirm_data';
    sessions[chatId] = sess;

    let reply = '🔍 <b>Данные после уточнения:</b>\n\n';
    reply += `👤 Имя: <b>${sess.name || '❓'}</b>\n`;
    reply += `📱 Телефон: <b>${sess.phone || '❓'}</b>\n`;
    reply += `🏙 Город: <b>${sess.city || '❓'}</b>\n\nВсё верно?`;

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
    await send(chatId, '🔎 Ищу ПВЗ в городе ' + sess.city + '...');
    try {
      const city = await findCity(sess.city);
      if (!city) return send(chatId, `❌ Город «${sess.city}» не найден в базе СДЭК.\n\nНапишите город ещё раз:`);

      sess.cityCode  = city.code;
      sess.city      = city.city;
      const pvzList  = await findPvz(city.code);

      if (!pvzList.length) return send(chatId, `❌ ПВЗ не найдены в городе ${city.city}.\n\nВозможно, доставка туда недоступна.`);

      sess.pvzOptions = pvzList.slice(0, 5);
      sess.step = 'select_pvz';
      sessions[chatId] = sess;

      let reply = `📍 <b>ПВЗ в городе ${city.city}:</b>\n\nВыберите один:`;
      const buttons = sess.pvzOptions.map((pvz, i) => [{
        text: `${i+1}. ${pvz.name} — ${pvz.location?.address || ''}`,
        callback_data: `pvz_${i}`
      }]);

      return send(chatId, reply, keyboard(buttons));
    } catch(e) {
      return send(chatId, '❌ Ошибка СДЭК: ' + e.message);
    }
  }

  if (data.startsWith('pvz_')) {
    const idx = parseInt(data.split('_')[1]);
    const pvz = sess.pvzOptions?.[idx];
    if (!pvz) return send(chatId, 'Ошибка — попробуйте /new');

    sess.pvzCode  = pvz.code;
    sess.pvzName  = pvz.name;
    sess.pvzAddr  = pvz.location?.address || '';
    sess.step = 'confirm_order';
    sessions[chatId] = sess;

    let reply = '📋 <b>Итоговые данные заказа:</b>\n\n';
    reply += `👤 ${sess.name}\n`;
    reply += `📱 ${sess.phone}\n`;
    reply += `📍 ПВЗ: ${sess.pvzName}\n`;
    reply += `🏠 ${sess.pvzAddr}\n\n`;
    reply += `📦 Ножницы маникюрные · 100 ₽\n`;
    reply += `⚖️ 300 г · 20×20×10 см\n\n`;
    reply += `Создать заказ?`;

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
        const num = result.entity.cdek_number || '(присваивается)';
        sessions[chatId] = { step: 'wait_order' };
        let reply = `✅ <b>Заказ создан!</b>\n\n`;
        reply += `📌 Номер СДЭК: <b>${num}</b>\n`;
        reply += `🔑 UUID: <code>${result.entity.uuid}</code>\n\n`;
        reply += `Для нового заказа нажмите /new`;
        return send(chatId, reply);
      } else if (result.errors?.length) {
        return send(chatId, '❌ Ошибка СДЭК:\n' + result.errors.map(e => e.message).join('\n'));
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
        if (update.message)            await handleMessage(update.message);
        if (update.callback_query)     await handleCallback(update.callback_query);
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

import 'dotenv/config';
import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { DatabaseSync } from 'node:sqlite';   // встроенная SQLite в Node 24 — без родных модулей
import * as chrono from 'chrono-node';

// Ошибки попадают в docker logs (раньше падали молча)
process.on('unhandledRejection', (e) => console.error('❌ Ошибка обработчика:', e?.stack || e));
process.on('uncaughtException', (e) => console.error('❌ Критическая ошибка:', e?.stack || e));

const bot = new Bot(process.env.BOT_TOKEN);
const db = new DatabaseSync(process.env.DB_PATH || 'data.db');

// ==================== БД ====================
db.exec(`
CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  owner_id INTEGER NOT NULL,
  chat_id INTEGER,
  xp INTEGER DEFAULT 0,
  boss_hp INTEGER DEFAULT 0,
  boss_max_hp INTEGER DEFAULT 0,
  boss_name TEXT,
  week_damage INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  max_user_id INTEGER UNIQUE NOT NULL,
  name TEXT,
  guild_id INTEGER REFERENCES guilds(id),
  xp INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL REFERENCES guilds(id),
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,
  reported_by INTEGER REFERENCES users(id),
  status TEXT DEFAULT 'pending',
  confirmed_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

const q = {
  guildByCode: db.prepare('SELECT * FROM guilds WHERE invite_code = ?'),
  createGuild: db.prepare('INSERT INTO guilds (name, invite_code, owner_id) VALUES (?,?,?)'),
  userByMaxId: db.prepare('SELECT * FROM users WHERE max_user_id = ?'),
  createUser:  db.prepare('INSERT INTO users (max_user_id, name) VALUES (?,?)'),
  setGuild:    db.prepare('UPDATE users SET guild_id = ? WHERE id = ?'),
  setGuildChat:db.prepare('UPDATE guilds SET chat_id = ? WHERE id = ?'),
  addXp:       db.prepare('UPDATE users SET xp = xp + ? WHERE id = ?'),
  similarEvent: db.prepare(`
    SELECT e.*, u.name AS reporter_name FROM events e
    LEFT JOIN users u ON u.id = e.reported_by
    WHERE e.guild_id = ? AND e.status != 'rejected'
      AND e.title LIKE ? AND date(e.due_at) = date(?)
    ORDER BY e.id LIMIT 1`),
  insertEvent: db.prepare('INSERT INTO events (guild_id,title,due_at,reported_by) VALUES (?,?,?,?)'),
  getEvent:    db.prepare('SELECT * FROM events WHERE id = ?'),
  confirmEvent:db.prepare("UPDATE events SET status='confirmed', confirmed_by=? WHERE id=?"),
  rejectEvent: db.prepare("UPDATE events SET status='rejected' WHERE id=?"),
  notifyEvent: db.prepare("UPDATE events SET status='notified' WHERE id=?"),
  guildMembers:db.prepare('SELECT * FROM users WHERE guild_id = ?'),
  getGuild:    db.prepare('SELECT * FROM guilds WHERE id = ?'),
  dueEvents:   db.prepare(`
    SELECT e.*, u.name AS reporter_name FROM events e
    LEFT JOIN users u ON u.id = e.reported_by
    WHERE e.status='confirmed' AND datetime(e.due_at)
      BETWEEN datetime('now') AND datetime('now','+1 day')`),
  summonBoss:  db.prepare("UPDATE guilds SET boss_name=?, boss_hp=?, boss_max_hp=?, week_damage=0 WHERE id=?"),
  applyDamage: db.prepare('UPDATE guilds SET boss_hp = boss_hp - ?, week_damage = week_damage + ? WHERE id = ?'),
  killBoss:    db.prepare("UPDATE guilds SET boss_hp = 0 WHERE id = ?"),
};

// ==================== Утилиты ====================
const code = (name) =>
  'DG-' + name.toUpperCase().replace(/[^А-ЯA-Z0-9]/g, '').slice(0, 4) + '-' +
  Math.floor(1000 + Math.random() * 9000);

// Текст сообщения: в SDK MAX тело сообщения — ctx.message.body.text
const textOf = (ctx) =>
  (ctx.message?.body?.text ?? ctx.message?.text ?? '').trim();

// Отправитель: в контексте SDK — ctx.message.sender
const senderOf = (ctx) => {
  const s = ctx.message?.sender ?? ctx.sender ?? ctx.update?.sender ?? {};
  const name = [s.first_name, s.last_name].filter(Boolean).join(' ').trim()
               || s.name || 'Герой';
  return { id: s.user_id, name };
};
const me = (ctx) => getUser(senderOf(ctx).id, senderOf(ctx).name);
const chatIdOf = (ctx) => ctx.chat_id ?? ctx.message?.recipient?.chat_id ?? null;

// Полный стектрейс ошибок в лог контейнера
const safe = (fn) => async (ctx) => {
  try { await fn(ctx); }
  catch (e) { console.error('❌ STACK: ' + (e?.stack || String(e))); }
};

const getUser = (maxId, name) => {
  let u = q.userByMaxId.get(maxId);
  if (!u) { q.createUser.run(maxId, name || 'Герой'); u = q.userByMaxId.get(maxId); }
  return u;
};

function parseEvent(text) {
  const results = chrono.ru.parse(text, new Date(), { forwardDate: true });
  if (!results.length) return null;
  const due = results[0].start.date();
  const title = text.replace(results[0].text, '').replace(/\s+/g, ' ').trim() || 'Событие';
  return { title, due };
}

const fmt = (d) => d.toLocaleString('ru-RU', { day: 'numeric', month: 'long',
  hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Asia/Novosibirsk' });

const bar = (hp, max) => {
  const total = 10, left = Math.max(0, Math.round(total * hp / max));
  return '🟥'.repeat(left) + '⬜'.repeat(total - left);
};

async function broadcast(guildId, text) {
  const g = q.getGuild.get(guildId);
  for (const m of q.guildMembers.all(guildId)) {
    try { await bot.api.sendMessageToUser(m.max_user_id, text); } catch {}
  }
  if (g?.chat_id) {
    try { await bot.api.sendMessageToChat(g.chat_id, text); } catch {}
  }
}

// ==================== Команды (маршрутизация своя: SDK сравнивает текст целиком) ====================
async function cmdStart(ctx) {
  const kb = Keyboard.inlineKeyboard([
    [Keyboard.button.callback('🏰 Создать гильдию', 'menu_create'),
     Keyboard.button.callback('⚔️ Вступить в гильдию', 'menu_join')],
  ]);
  await ctx.reply(
    'Привет, герой! Я Хранитель Подземелья 🏰\n' +
    'Помогаю классу всё успевать: дедлайны, контрольные, боссы. Выбери действие:',
    { attachments: [kb] });
}

async function cmdCreateClan(ctx, name) {
  if (!name) return ctx.reply('Использование: /create_clan 6А');
  const user = me(ctx);
  const invite = code(name);
  const r = q.createGuild.run(name, invite, user.id);
  q.setGuild.run(r.lastInsertRowid, user.id);   // создатель — сразу член гильдии
  q.summonBoss.run('Дракон Незачётов', 27 * 50, 27 * 50, r.lastInsertRowid);
  await ctx.reply(
    `🏰 Гильдия «${name}» создана!\nКод приглашения: <b>${invite}</b>\n\n` +
    `Ученики вводят: /join ${invite}\n` +
    `Добавьте меня в групповой чат класса и напишите там: /bind_chat ${invite}`);
}

async function cmdJoin(ctx, codeArg) {
  const g = q.guildByCode.get(codeArg);
  if (!g) return ctx.reply('Такого кода нет. Проверь у классного руководителя!');
  const user = me(ctx);
  q.setGuild.run(g.id, user.id);
  await ctx.reply(`⚔️ Ты в гильдии «${g.name}»! Выполняй задачи — твой XP идёт в общий зачёт.`);
}

async function cmdBindChat(ctx, codeArg) {
  const g = q.guildByCode.get(codeArg);
  const user = me(ctx);
  if (!g || g.owner_id !== user.id) return;
  q.setGuildChat.run(chatIdOf(ctx), g.id);
  await ctx.reply(`🔗 Чат привязан к гильдии «${g.name}». Достижения будут публиковаться сюда.`);
}

async function cmdRating(ctx) {
  const user = me(ctx);
  if (!user.guild_id) return ctx.reply('Сначала вступи в гильдию: /join КОД');
  const top = q.guildMembers.all(user.guild_id).sort((a, b) => b.xp - a.xp).slice(0, 3);
  const g = q.getGuild.get(user.guild_id);
  await ctx.reply(
    `🐉 Босс: ${g.boss_name} ${bar(g.boss_hp, g.boss_max_hp)} ${g.boss_hp}/${g.boss_max_hp} HP\n\n` +
    '🏆 Топ гильдии:\n' +
    top.map((m, i) => `${['🥇','🥈','🥉'][i]} ${m.name} — ${m.xp} XP`).join('\n'));
}

async function cmdRaid(ctx, args) {
  const user = me(ctx);
  const g = user.guild_id ? q.getGuild.get(user.guild_id) : null;
  if (!g || g.owner_id !== user.id) return ctx.reply('Рейд объявляет классный руководитель.');
  const [m5, m4, m3, m2] = args.map(Number);
  if ([m5, m4, m3, m2].some(isNaN))
    return ctx.reply('Формат: /рейд 4 5 2 1 — количество пятёрок, четвёрок, троек, двоек за неделю');

  const dmg = m5 * 30 + m4 * 15 - m3 * 10 - m2 * 30;
  const avg = (m5 * 5 + m4 * 4 + m3 * 3 + m2 * 2) / Math.max(1, m5 + m4 + m3 + m2);
  const vuln = avg >= 4.5 ? 1.5 : 1;
  const finalDmg = Math.round(dmg * vuln);

  db.prepare(`UPDATE guilds SET boss_hp = MIN(boss_max_hp, boss_hp - ?),
              week_damage = week_damage + ? WHERE id = ?`).run(finalDmg, finalDmg, g.id);
  const g2 = q.getGuild.get(g.id);

  let report = `⚔️ *Рейд недели!* Гильдия «${g.name}» нанесла ${finalDmg} урона` +
    (vuln > 1 ? ' (уязвимость ×1.5 за средний балл ≥4.5!)' : '') + `\n` +
    `🗡️ 5ок: ${m5} (−${m5*30}) · 4ок: ${m4} (−${m4*15}) · 3ек: ${m3} (+${m3*10}) · 2оек: ${m2} (+${m2*30})\n` +
    `🐉 ${g2.boss_name}: ${bar(g2.boss_hp, g2.boss_max_hp)} ${Math.max(0, g2.boss_hp)}/${g2.boss_max_hp} HP`;

  if (g2.boss_hp <= 0) {
    q.killBoss.run(g.id);
    report += `\n\n🏆 *БОСС ПОВЕРЖЕН!* Гильдия открывает сундук: неделя двойного XP!`;
  }
  await broadcast(g.id, report);
}

// ==================== Регистрация обработчиков ====================
// (архитектура повторяет рабочую версию: bot.command — команды,
//  bot.on('command message_created') — обычный текст; аргументы читаем из текста)
bot.on('bot_started', safe(async (ctx) => { console.log('🚀 bot_started от', senderOf(ctx).id); return cmdStart(ctx); }));
bot.command('start',       safe(async (ctx) => cmdStart(ctx)));
bot.command('create_clan', safe(async (ctx) => cmdCreateClan(ctx, argsOf(ctx).join(' '))));
bot.command('join',        safe(async (ctx) => cmdJoin(ctx, argsOf(ctx)[0])));
bot.command('bind_chat',   safe(async (ctx) => cmdBindChat(ctx, argsOf(ctx)[0])));
bot.command('rating',      safe(async (ctx) => cmdRating(ctx)));
bot.command('рейд',        safe(async (ctx) => cmdRaid(ctx, argsOf(ctx))));

// ==================== Разведка + маршрутизация команд ====================
bot.on('command message_created', safe(async (ctx) => {
  const text = textOf(ctx);
  console.log(`📨 [${new Date().toISOString()}] message_created: "${text.slice(0, 80)}"`);
  if (!text) return;

  // Команды (с /) обрабатываются через bot.command — здесь только обычный текст
  if (text.startsWith('/')) return;

  // --- РАЗВЕДКА: обычное сообщение с датой ---
  const user = me(ctx);
  if (!user.guild_id) {
    return ctx.reply('Ты пока не в гильдии. Вступи: /join КОД (код выдаёт классный руководитель) или создай свою: /create_clan 6А');
  }

  const parsed = parseEvent(text);
  if (!parsed) return;

  // ДЕДУПЛИКАЦИЯ: одно событие — одна запись
  const dup = q.similarEvent.get(user.guild_id, `%${parsed.title.slice(0, 12)}%`, parsed.due.toISOString());
  if (dup) {
    return ctx.reply(dup.status === 'confirmed'
      ? `Это уже знает вся гильдия — сообщил ${dup.reporter_name || 'советник'} ✅ Спасибо, что проверил!`
      : `Это уже проверяет советник — сообщил ${dup.reporter_name || 'кто-то из отряда'} ⏳`);
  }

  const ev = q.insertEvent.run(user.guild_id, parsed.title, parsed.due.toISOString(), user.id);
  await ctx.reply(
    `🗺️ Разведка записана: «${parsed.title}», ${fmt(parsed.due)}.\n` +
    `Как только совет гильдии подтвердит — весь отряд узнает. +10 XP за инфу!`);

  const g = q.getGuild.get(user.guild_id);
  const kb = Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✅ Подтвердить', `ev_ok_${ev.lastInsertRowid}`)],
    [Keyboard.button.callback('🚫 Игнор', `ev_no_${ev.lastInsertRowid}`)],
  ]);
  const ownerMaxId = db.prepare('SELECT max_user_id FROM users WHERE id=?').get(g.owner_id).max_user_id;
  await bot.api.sendMessageToUser(g.owner_id !== user.id ? ownerMaxId : senderOf(ctx).id,
    `👀 ${user.name} сообщает: «${parsed.title}» — ${fmt(parsed.due)}`,
    { attachments: [kb] });
}));

// ==================== Кнопки ====================
bot.on('event', safe(async (ctx) => {
  if (ctx.event.payload === 'menu_create')
    return ctx.reply('Чтобы создать гильдию, введи:\n/create_clan 6А');
  if (ctx.event.payload === 'menu_join')
    return ctx.reply('Чтобы вступить в гильдию, введи:\n/join КОД\n(код выдаёт классный руководитель)');

  const m = ctx.event.payload.match(/^ev_(ok|no)_(\d+)$/);
  if (!m) return;
  const ev = q.getEvent.get(+m[2]);
  if (!ev || ev.status !== 'pending') return;

  if (m[1] === 'no') {
    q.rejectEvent.run(ev.id);
    return ctx.reply('Отклонено. Разведчик получит XP в другой раз.');
  }

  q.confirmEvent.run(me(ctx).id, ev.id);
  if (ev.reported_by) {
    q.addXp.run(10, ev.reported_by);
    const rep = db.prepare('SELECT max_user_id FROM users WHERE id=?').get(ev.reported_by);
    try { await bot.api.sendMessageToUser(rep.max_user_id,
      '🏅 Совет подтвердил! Вся гильдия узнала вовремя. +10 XP.'); } catch {}
  }

  await broadcast(ev.guild_id,
    `⚔️ Внимание, отряд!\n📅 ${fmt(new Date(ev.due_at))}: <b>${ev.title}</b>\nХранитель напомнит заранее. Вперёд!`);
  await ctx.reply('✅ Опубликовано для всей гильдии.');
}));

// ==================== Напоминания ====================
setInterval(async () => {
  for (const ev of q.dueEvents.all()) {
    await broadcast(ev.guild_id,
      `⏰ Напоминание от Хранителя:\n<b>${ev.title}</b> — завтра, ${fmt(new Date(ev.due_at))}`);
    q.notifyEvent.run(ev.id);
  }
}, 60 * 1000);

bot.start();
console.log('🏰 Хранитель Подземелья работает');

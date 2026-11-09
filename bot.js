import 'dotenv/config';
import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { DatabaseSync } from 'node:sqlite';   // встроенная SQLite в Node 24 — без родных модулей
import * as chrono from 'chrono-node';

const bot = new Bot(process.env.BOT_TOKEN);
const db = new DatabaseSync(process.env.DB_PATH || 'data.db');

// ==================== БД ====================
db.exec(`
CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  owner_id INTEGER NOT NULL,          -- user_id КР в MAX
  chat_id INTEGER,                    -- привязанный групповой чат класса
  xp INTEGER DEFAULT 0,
  boss_hp INTEGER DEFAULT 0,          -- HP текущего босса
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
  status TEXT DEFAULT 'pending',      -- pending / confirmed / rejected / notified
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

const getUser = (maxId, name) => {
  let u = q.userByMaxId.get(maxId);
  if (!u) { q.createUser.run(maxId, name || 'Герой'); u = q.userByMaxId.get(maxId); }
  return u;
};

function parseEvent(text) {
  // chrono v2: русская локаль явно (по умолчанию — только английский)
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

// ==================== Команды ====================
bot.command('start', async (ctx) => {
  const kb = Keyboard.inlineKeyboard([
    [Keyboard.button.callback('🏰 Создать гильдию', 'menu_create'),
     Keyboard.button.callback('⚔️ Вступить в гильдию', 'menu_join')],
  ]);
  await ctx.reply(
    'Привет, герой! Я Хранитель Подземелья 🏰\n' +
    'Помогаю классу всё успевать: дедлайны, контрольные, боссы. Выбери действие:',
    { attachments: [kb] });
});

bot.command('create_clan', async (ctx) => {
  const name = ctx.args.join(' ');
  if (!name) return ctx.reply('Использование: /create_clan 6А');
  const user = getUser(ctx.sender.user_id, ctx.sender.name);
  const invite = code(name);
  const r = q.createGuild.run(name, invite, user.id);
  // стартовый босс четверти: HP = 50 на ученика (по умолчанию 27)
  q.summonBoss.run('Дракон Незачётов', 27 * 50, 27 * 50, r.lastInsertRowid);
  await ctx.reply(
    `🏰 Гильдия «${name}» создана!\nКод приглашения: <b>${invite}</b>\n\n` +
    `Ученики вводят: /join ${invite}\n` +
    `Добавьте меня в групповой чат класса и напишите там: /bind_chat ${invite}`);
});

bot.command('join', async (ctx) => {
  const g = q.guildByCode.get(ctx.args[0]);
  if (!g) return ctx.reply('Такого кода нет. Проверь у классного руководителя!');
  const user = getUser(ctx.sender.user_id, ctx.sender.name);
  q.setGuild.run(g.id, user.id);
  await ctx.reply(`⚔️ Ты в гильдии «${g.name}»! Выполняй задачи — твой XP идёт в общий зачёт.`);
});

bot.command('bind_chat', async (ctx) => {
  const g = q.guildByCode.get(ctx.args[0]);
  const user = getUser(ctx.sender.user_id);
  if (!g || g.owner_id !== user.id) return;
  q.setGuildChat.run(ctx.chat_id, g.id);
  await ctx.reply(`🔗 Чат привязан к гильдии «${g.name}». Достижения будут публиковаться сюда.`);
});

bot.command('rating', async (ctx) => {
  const user = getUser(ctx.sender.user_id);
  if (!user.guild_id) return ctx.reply('Сначала вступи в гильдию: /join КОД');
  const top = q.guildMembers.all(user.guild_id).sort((a, b) => b.xp - a.xp).slice(0, 3);
  const g = q.getGuild.get(user.guild_id);
  await ctx.reply(
    `🐉 Босс: ${g.boss_name} ${bar(g.boss_hp, g.boss_max_hp)} ${g.boss_hp}/${g.boss_max_hp} HP\n\n` +
    '🏆 Топ гильдии:\n' +
    top.map((m, i) => `${['🥇','🥈','🥉'][i]} ${m.name} — ${m.xp} XP`).join('\n'));
});

// ---- Рейд отметок (ручной ввод; OCR — в бете) ----
bot.command('рейд', async (ctx) => {
  const user = getUser(ctx.sender.user_id);
  const g = user.guild_id ? q.getGuild.get(user.guild_id) : null;
  if (!g || g.owner_id !== user.id) return ctx.reply('Рейд объявляет классный руководитель.');
  // /рейд <пятёрок> <четвёрок> <троек> <двоек>
  const [m5, m4, m3, m2] = ctx.args.map(Number);
  if ([m5, m4, m3, m2].some(isNaN))
    return ctx.reply('Формат: /рейд 4 5 2 1 — количество пятёрок, четвёрок, троек, двоек за неделю');

  const dmg = m5 * 30 + m4 * 15 - m3 * 10 - m2 * 30;
  const avg = (m5 * 5 + m4 * 4 + m3 * 3 + m2 * 2) / Math.max(1, m5 + m4 + m3 + m2);
  const vuln = avg >= 4.5 ? 1.5 : 1;
  const finalDmg = Math.round(dmg * vuln);

  // урон вычитается; отрицательный урон лечит, но не выше максимума HP
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
});

// ==================== Разведка ====================
bot.on('message_created', async (ctx) => {
  const text = ctx.message.text;
  if (!text || text.startsWith('/')) return;
  const user = getUser(ctx.sender.user_id, ctx.sender.name);
  if (!user.guild_id) return;

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
  await bot.api.sendMessageToUser(g.owner_id !== user.id ? ownerMaxId : ctx.sender.user_id,
    `👀 ${user.name} сообщает: «${parsed.title}» — ${fmt(parsed.due)}`,
    { attachments: [kb] });
});

bot.on('event', async (ctx) => {
  const m = ctx.event.payload.match(/^ev_(ok|no)_(\d+)$/);
  if (!m) return;
  const ev = q.getEvent.get(+m[2]);
  if (!ev || ev.status !== 'pending') return;

  if (m[1] === 'no') {
    q.rejectEvent.run(ev.id);
    return ctx.reply('Отклонено. Разведчик получит XP в другой раз.');
  }

  q.confirmEvent.run(getUser(ctx.sender.user_id).id, ev.id);
  if (ev.reported_by) {
    q.addXp.run(10, ev.reported_by);
    const rep = db.prepare('SELECT max_user_id FROM users WHERE id=?').get(ev.reported_by);
    try { await bot.api.sendMessageToUser(rep.max_user_id,
      '🏅 Совет подтвердил! Вся гильдия узнала вовремя. +10 XP.'); } catch {}
  }

  const g = q.getGuild.get(ev.guild_id);
  await broadcast(ev.guild_id,
    `⚔️ Внимание, отряд!\n📅 ${fmt(new Date(ev.due_at))}: <b>${ev.title}</b>\nХранитель напомнит заранее. Вперёд!`);
  await ctx.reply('✅ Опубликовано для всей гильдии.');
});

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

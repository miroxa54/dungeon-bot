# 🏰 Хранитель Подземелья

Бот-гильдия для школьного класса в MAX (Сферуме): разведка дедлайнов,
боссы, рейды отметок.

## ⚠️ Перед сборкой: сертификат Минцифры

API MAX (`platform-api2.max.ru`) использует TLS-сертификат Нац. УЦ Минцифры,
которого нет в Node.js по умолчанию. Скачайте корневой сертификат и положите
рядом с Dockerfile:

```bash
curl -O https://www.gosuslugi.ru/crt/russian_trusted_root_ca.pem
# файл russian_trusted_root_ca.pem положите рядом с Dockerfile
```

Если ссылка недоступна — скачайте сертификат на портале Минцифры
(«Корневые сертификаты Национального удостоверяющего центра») и сохраните
как `russian_trusted_root_ca.pem`.

Без этого шага бот упадёт с ошибкой `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.

## Запуск через Docker

```bash
cp .env.example .env        # впишите BOT_TOKEN с dev.max.ru
docker compose up -d --build
docker compose logs -f      # смотреть логи
```

## Команды бота

| Команда | Кто | Что делает |
|---|---|---|
| /start | все | приветствие, кнопки входа |
| /create_clan 6А | КР | создать гильдию, выдать код-приглашение |
| /join КОД | ученик | вступить в гильдию |
| /bind_chat КОД | КР (в групповом чате) | привязать чат класса |
| /rating | все | HP-бар босса + топ гильдии |
| /рейд 4 5 2 1 | КР | рейд отметок за неделю (5ок, 4ок, 3ек, 2оек) |
| «завтра контрольная по истории» | ученик | разведка → подтверждение КР → всем + напоминания |

## Урон в рейде

5ка = −30 HP, 4ка = −15, 3ка = +10 (лечит босса), 2ка = +30.
Средний балл ≥4.5 → уязвимость ×1.5. HP босса = 50 × число учеников.

## Данные

SQLite в volume `dungeon-data` (`/app/data/data.db`) — не теряются при
пересоздании контейнера.


## Сдача организаторам (docker-образ)

Токен не нужен на этапе сборки — он передаётся при запуске контейнера.

```bash
# 1. Скачать сертификат Минцифры
curl -O https://www.gosuslugi.ru/crt/russian_trusted_root_ca.pem

# 2. Собрать и упаковать
chmod +x build.sh && ./build.sh
#    -> dungeon-bot-image.tar.gz
```

У организаторов / на площадке:

```bash
gunzip -c dungeon-bot-image.tar.gz | docker load
docker run -d --name dungeon-bot \
  -e BOT_TOKEN=токен_который_предоставят \
  -e TZ=Asia/Novosibirsk \
  -v dungeon-data:/app/data \
  dungeon-bot:1.0.0

docker logs -f dungeon-bot   # проверка: "🏰 Хранитель Подземелья работает"
```

Образ самодостаточен: Node.js + зависимости + сертификат Минцифры.
Скачивать ничего не требуется, кроме самого образа.


## Структура репозитория

| Файл | Назначение |
|---|---|
| `bot.js` | весь код бота (ES-модуль, Node.js 20) |
| `Dockerfile` | многослойная сборка образа + сертификат Минцифры |
| `docker-compose.yml` | запуск через compose (env_file .env) |
| `build.sh` | сборка образа и экспорт в `dungeon-bot-image.tar.gz` |
| `requirements.txt` | библиотеки и версии |
| `dungeon-bot-image.tar.gz` | **готовый Docker-образ** (появляется после `./build.sh`) |

## Публикация на GitHub

```bash
git init
git add .
git commit -m "Хранитель Подземелья v1.0.0"
git remote add origin https://github.com/ВАШ_ЛОГИН/dungeon-bot.git
git push -u origin main
# затем: ./build.sh и закоммить dungeon-bot-image.tar.gz
# (файл < 100 МБ — лимит GitHub выдержит)
```

## Запуск без Docker (командная строка)

```bash
npm install
curl -O https://www.gosuslugi.ru/crt/russian_trusted_root_ca.pem
BOT_TOKEN=токен NODE_EXTRA_CA_CERTS=./russian_trusted_root_ca.pem \
  TZ=Asia/Novosibirsk node bot.js
```

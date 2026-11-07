#!/usr/bin/env bash
# Сборка docker-образа и упаковка в tar.gz для передачи организаторам
set -e

IMAGE="dungeon-bot:1.0.0"

if [ ! -f russian_trusted_root_ca.pem ]; then
  echo "❌ Не найден russian_trusted_root_ca.pem"
  echo "   Скачайте: curl -O https://www.gosuslugi.ru/crt/russian_trusted_root_ca.pem"
  exit 1
fi

echo "→ Сборка $IMAGE"
docker build -t "$IMAGE" .

echo "→ Экспорт в dungeon-bot-image.tar.gz (займёт минуту)"
docker save "$IMAGE" | gzip > dungeon-bot-image.tar.gz

echo "✅ Готово: dungeon-bot-image.tar.gz"
echo ""
echo "Запуск у организаторов:"
echo "  gunzip -c dungeon-bot-image.tar.gz | docker load"
echo "  docker run -d --name dungeon-bot \"
echo "    -e BOT_TOKEN=ВАШ_ТОКЕН \"
echo "    -e TZ=Asia/Novosibirsk \"
echo "    -v dungeon-data:/app/data \"
echo "    dungeon-bot:1.0.0"

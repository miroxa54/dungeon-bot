# ---------- Сборка ----------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ---------- Запуск ----------
FROM node:20-bookworm-slim
ENV NODE_ENV=production

# 1) Кладём корневой сертификат Минцифры в системное хранилище —
#    без него TLS к platform-api2.max.ru не установится.
#    Скачайте заранее: https://www.gosuslugi.ru/crt/russian_trusted_root_ca.pem
COPY russian_trusted_root_ca.pem /usr/local/share/ca-certificates/russian_trusted_root_ca.crt
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates && rm -rf /var/lib/apt/lists/*
# 2) Дублируем для Node.js (он не всегда читает системное хранилище)
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/russian_trusted_root_ca.crt

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bot.js ./
RUN mkdir -p /app/data
ENV DB_PATH=/app/data/data.db
USER node
CMD ["node", "bot.js"]

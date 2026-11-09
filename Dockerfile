# ---------- Сборка ----------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ---------- Запуск ----------
FROM node:24-bookworm-slim
ENV NODE_ENV=production

# ОБА сертификата цепочки НУЦ Минцифры: root + sub.
# Скачайте заранее с gu-st.ru:
#   curl -O https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
#   curl -O https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt
COPY russian_trusted_root_ca_pem.crt russian_trusted_sub_ca_pem.crt \
     /usr/local/share/ca-certificates/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates && rm -rf /var/lib/apt/lists/*
# Node 24: используем системное хранилище (fetch игнорирует NODE_EXTRA_CA_CERTS)
ENV NODE_OPTIONS=--use-openssl-ca

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bot.js ./
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV DB_PATH=/app/data/data.db
USER node
CMD ["node", "bot.js"]

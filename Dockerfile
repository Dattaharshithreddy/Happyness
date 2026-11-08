# Happyness server: no npm dependencies, just Node 22 (built-in SQLite).
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY public ./public
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    TRUST_PROXY=1
VOLUME ["/data"]
EXPOSE 8080
USER node
CMD ["node", "server/server.js"]

# OnePanel 官方镜像
FROM node:22-alpine AS build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/qxsraiy/onepanel-home"
WORKDIR /app
# 运行时依赖
COPY backend/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY backend/ ./
COPY --from=build /app/dist ./public
COPY start.sh upgrade.sh ./
RUN chmod +x start.sh upgrade.sh && mkdir -p /data /backups
ENV PORT=5266 OP_DATA_DIR=/data DATABASE_URL=file:/data/onepanel.db NODE_ENV=production
EXPOSE 5266
VOLUME ["/data", "/backups"]
CMD ["node", "index.js"]

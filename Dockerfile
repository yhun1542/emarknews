# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# 락파일 동기화된 전제에서 설치
RUN npm ci --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# node_modules 복사
COPY --from=deps /app/node_modules ./node_modules

# 앱 소스 복사
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]


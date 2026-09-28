# Contexto de build: raiz de ESTE repo (hotelsync-booking-service).
# Uso: docker build -t hotelsync-booking-service .
FROM node:20-alpine AS builder

WORKDIR /app

# Manifiestos para aprovechar cache de capas
COPY package.json package-lock.json ./

RUN npm ci

# Codigo necesario para generar Prisma Client y compilar
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src

RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

EXPOSE 3004
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]

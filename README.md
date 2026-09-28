# hotelsync-booking-service

Microservicio Booking de HotelSync: reservas con bloqueo optimista contra sobreventa.

Extraído del monorepo HotelSync como repo autocontenido (un repo por microservicio).

## Stack

Node 20 · Express 4 · Prisma 6 (PostgreSQL) · RabbitMQ (amqplib) · TypeScript · Jest + ts-jest

## Variables de entorno

| Variable           | Uso                                             |
| ------------------ | ----------------------------------------------- |
| `PORT`             | Puerto HTTP (Render inyecta el suyo, ej. 10000) |
| `DATABASE_URL`     | Conexión **con pooling** para runtime           |
| `DIRECT_URL`       | Conexión **directa** solo para `migrate deploy` |
| `RATE_SERVICE_URL` | URL base del rate-availability (`.../v1`)       |
| `RABBITMQ_URL`     | RabbitMQ (CloudAMQP); vacío = sin eventos       |
| `NODE_ENV`         | `development` / `production`                    |

Ver `.env.example`. Sin `RABBITMQ_URL` el servicio arranca igual pero no publica eventos.

## Scripts

- `npm run dev` — desarrollo con recarga
- `npm run build` / `npm start` — compilación y arranque
- `npm run lint` — `tsc --noEmit`
- `npm test` — Jest (unit + integration; integración requiere DB)
- `npm run seed` — datos de ejemplo

## Health

`GET /health` → `{ status: "ok" }` (usado como healthCheckPath en Render).

## Despliegue (Render, plan free)

Build: `npm ci && npx prisma generate && npm run build`
Start: `npx prisma migrate deploy && npm start`

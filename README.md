# HotelSync — Booking Service

Microservicio de reservas de HotelSync: crea, confirma y cancela reservas con control optimista de versión y coordina el inventario con Rate & Availability para evitar sobreventa.

- **Producción:** https://hotelsync-booking-service.onrender.com
- **Puerto local:** 3004
- **Base de datos:** `booking_db` (PostgreSQL 16)

## Responsabilidad

| Hace | No hace |
| --- | --- |
| Crear/confirmar/cancelar reservas | Gestionar inventario (reserva y libera vía R&A) |
| Evitar sobreventa con reserva atómica + versión optimista (409) | Cobrar (emite/consume eventos de pago) |
| Emitir `booking.created/confirmed/cancelled/paid` | Hacer check-in/check-out |
| Aceptar reservas OTA del channel-manager con clave interna | Ser dueño de tarifas ni del catálogo |

## Tecnologías

Node.js ≥20 · TypeScript · Express · Prisma · PostgreSQL 16 · Zod · RabbitMQ (outbox + consumidor de pagos).

## Arquitectura interna

`Route → Controller → Service → Prisma`. La creación abre una transacción, llama a R&A (`/availability/reserve`) y persiste la reserva; si algo falla, libera el inventario (`/release`) como compensación. La confirmación usa versión optimista: un `version` desactualizado devuelve **409**. Los eventos se encolan en `EventOutbox` dentro de la transacción y un dispatcher los publica.

La cancelación no borra la reserva: la pasa a `cancelled` y libera inventario. El dueño exacto (`booked_by_user_id`) puede cancelar desde "Mis reservas" sólo antes del check-in y mientras siga `pending`/`confirmed`; el staff no tiene esa restricción. Si estaba paga, payment-service consume `booking.cancelled` y emite `payment.refunded`, que este servicio aplica como `payment_status = REFUNDED`.

## Endpoints

| Método | Ruta | Auth | Descripción |
| --- | --- | --- | --- |
| GET | `/health` | — | Estado del servicio |
| GET | `/v1/bookings` | JWT + staff | Lista reservas con filtros |
| POST | `/v1/bookings` | JWT opcional / `x-channel-manager-key` | Crea reserva (OTA exige clave del channel-manager) |
| GET | `/v1/bookings/me` | JWT | Reservas del usuario |
| GET | `/v1/bookings/by-user/:userId/has-active` | `x-user-key` | ¿Tiene reservas activas? (user-service) |
| GET | `/v1/bookings/:id` | JWT o `x-manage-token` | Detalle de reserva |
| POST | `/v1/bookings/:id/confirm` | JWT o `x-manage-token` | Confirma (versión optimista, 409 en conflicto) |
| POST | `/v1/bookings/:id/cancel` | JWT del dueño, staff o `x-manage-token` | Cancela y libera inventario (no staff: sólo antes del check-in) |

Claves internas aceptadas: `x-user-key`, `x-payment-key`, `x-billing-key`, `x-front-desk-key`, `x-housekeeping-key`, `x-loyalty-key`, `x-channel-manager-key`.

## Modelo de datos

Tablas: `Booking`, `InventoryReservationAttempt`, `EventOutbox`.

Migraciones en `prisma/migrations` (7). Seed: una reserva demo (`hotel_id` 2222…, `room_type_id` 3333…).

## Comunicación

- **REST saliente:** Rate & Availability `POST /v1/availability/reserve` y `/release` (header `x-service-key`).
- **Publica:** `booking.created`, `booking.confirmed`, `booking.cancelled`, `booking.paid`.
- **Consume:** `payment.completed` (cola durable `booking.payments`) → marca la reserva como pagada; `payment.refunded` (cola durable `booking.refunds`) → `payment_status = REFUNDED`.
- **Entrante:** front-desk, billing, housekeeping, loyalty, user y payment consultan reservas con sus respectivas claves.

## Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `PORT` | No | Puerto HTTP (default 3004) |
| `DATABASE_URL` | Sí | PostgreSQL de `booking_db` |
| `AUTH_JWT_SECRET` | Sí | HS256 compartido |
| `RATE_SERVICE_URL` | Sí | Base de Rate & Availability |
| `SERVICE_API_KEY` | Sí | Clave hacia R&A (`x-service-key`) |
| `RABBITMQ_URL` | No | Sin ella el outbox queda `pending` |
| `CHANNEL_MANAGER_SERVICE_KEY` | Sí | Clave que presenta el channel-manager |
| `CHANNEL_MANAGER_MANAGE_TOKEN_SECRET` | Sí | Firma de `x-manage-token` de reservas OTA |
| `PAYMENT_SERVICE_KEY` | Sí | Debe coincidir con payment-service |
| `USER_SERVICE_KEY` | Sí | Debe coincidir con user-service |
| `BILLING_SERVICE_KEY` | Sí | Debe coincidir con billing-service |
| `FRONT_DESK_SERVICE_KEY` | Sí | Debe coincidir con front-desk-service |
| `HOUSEKEEPING_SERVICE_KEY` | Sí | Debe coincidir con housekeeping-service |
| `LOYALTY_SERVICE_KEY` | Sí | Debe coincidir con loyalty-service |

Copiar `.env.example` a `.env` y completar los valores.

## Ejecución local

```bash
npm install
cp .env.example .env
npx prisma migrate deploy
npm run seed
npm run dev                 # http://localhost:3004
```

## Despliegue

Render (Oregon, free): build `npm ci && npx prisma generate && npm run build`; start `npx prisma migrate deploy && npm start`; Neon `booking_db`. El plan free duerme a los 15 minutos.

## Pruebas y verificación

```bash
npm test
npm run lint
curl https://hotelsync-booking-service.onrender.com/health
```

## Respaldo de base de datos

```bash
pg_dump "$DATABASE_URL" -Fc -f booking_db.dump
pg_restore --clean --if-exists -d "$DATABASE_URL" booking_db.dump
```

## Estructura

```
src/{routes,controllers,services,validators,middleware,lib}
prisma/{schema.prisma,seed.ts,migrations}
tests/
```

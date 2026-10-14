import express from "express";
import { errorHandler } from "./middleware/error-handler.js";
import bookingsRouter from "./routes/bookings.js";
import { startOutboxDispatcher } from "./lib/outbox.js";
import { startConfirmationReconciler } from "./lib/confirmation-reconciler.js";
import { startPaymentConsumer } from "./lib/consumer.js";

const app = express();
const PORT = process.env.PORT || 3004;

app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "booking-service",
  });
});

// API routes
app.use("/v1/bookings", bookingsRouter);

// Error handler
app.use(errorHandler);

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Booking Service running on port ${PORT}`);
  });

  // Drena el outbox a RabbitMQ (solo con broker configurado; sin
  // RABBITMQ_URL el servicio opera igual y los eventos quedan pending).
  if (process.env.RABBITMQ_URL) {
    startOutboxDispatcher();
    console.log("Outbox dispatcher started (hotelsync.events)");

    // payment.completed → confirma (si hace falta) y marca PAID.
    startPaymentConsumer().catch((err) =>
      console.error("[payments-consumer] no se pudo iniciar", err)
    );
  }

  startConfirmationReconciler();
  console.log("Inventory confirmation reconciler started");
}

export default app;

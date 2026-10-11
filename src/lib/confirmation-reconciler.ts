import { bookingService } from "../services/booking.service.js";

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 50;

/**
 * Periodically resumes durable Booking → R&A confirmation sagas. A single
 * process-local lock avoids overlapping batches; DB state remains the source
 * of truth if the process restarts or multiple replicas run this worker.
 */
export function startConfirmationReconciler(
  intervalMs = DEFAULT_INTERVAL_MS,
  batchSize = DEFAULT_BATCH_SIZE
): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const reconciled =
        await bookingService.reconcilePendingConfirmations(batchSize);
      if (reconciled > 0) {
        console.info(`[confirmation-reconciler] examined=${reconciled}`);
      }
    } catch (error) {
      console.error("[confirmation-reconciler] batch failed", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return timer;
}

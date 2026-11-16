import { Request, Response, NextFunction } from "express";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public error: string = "Error"
  ) {
    super(message);
    this.name = "AppError";
  }
}

// Errores del cliente que express/body-parser marcan con `type`/`statusCode`.
type HttpLikeError = Error & {
  statusCode?: number;
  status?: number;
  expose?: boolean;
  type?: string;
};

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const httpErr = err as HttpLikeError;

  if (httpErr.type === "entity.parse.failed") {
    res.status(400).json({
      error: "BadRequest",
      message: "Cuerpo JSON inválido",
      statusCode: 400,
    });
    return;
  }

  if (httpErr.type === "entity.too.large") {
    res.status(413).json({
      error: "PayloadTooLarge",
      message: "Cuerpo de la petición demasiado grande",
      statusCode: 413,
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.error,
      message: err.message,
      statusCode: err.statusCode,
    });
    return;
  }

  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal Server Error",
    message: "An unexpected error occurred",
    statusCode: 500,
  });
}

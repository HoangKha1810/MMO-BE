import { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "./app-error.js";

type AsyncHandler = (
  request: Request,
  response: Response,
  next: NextFunction,
) => Promise<unknown>;

export function asyncHandler(handler: AsyncHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

export function getIpAddress(request: Request) {
  const forwardedIp = request.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim();
  const realIp = request.headers["x-real-ip"]?.toString().trim();
  const cloudflareIp = request.headers["cf-connecting-ip"]?.toString().trim();

  return cloudflareIp || realIp || forwardedIp || request.ip || "unknown";
}

export function requireValue<T>(
  value: T | undefined | null,
  message: string,
  statusCode = 404,
) {
  if (value === undefined || value === null) {
    throw new AppError(message, statusCode);
  }

  return value;
}

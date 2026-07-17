import { NextFunction, Request, Response } from "express";
import { AppError } from "../utils/app-error.js";
import { SanitizedUser, verifyAccessToken } from "../utils/security.js";

declare global {
  namespace Express {
    interface Request {
      authUser?: SanitizedUser;
    }
  }
}

function getBearerToken(request: Request) {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice(7);
}

export function authMiddleware(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      throw new AppError("Bạn chưa đăng nhập.", 401);
    }

    request.authUser = verifyAccessToken(token);
    next();
  } catch (error) {
    next(new AppError("Phiên đăng nhập không hợp lệ.", 401, error));
  }
}

export function adminMiddleware(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  if (!request.authUser) {
    return next(new AppError("Bạn chưa đăng nhập.", 401));
  }

  if (request.authUser.role !== "admin") {
    return next(new AppError("Bạn không có quyền truy cập khu vực admin.", 403));
  }

  next();
}

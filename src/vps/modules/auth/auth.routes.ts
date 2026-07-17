import { Router } from "express";
import { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { queryRows, executeResult } from "../../db/pool.js";
import { authMiddleware } from "../../middleware/auth.js";
import { AppError } from "../../utils/app-error.js";
import { asyncHandler, getIpAddress } from "../../utils/http.js";
import { buildPublicAssetUrl } from "../../utils/media.js";
import {
  comparePassword,
  hashPassword,
  SanitizedUser,
  signAccessToken,
  UserRole,
} from "../../utils/security.js";

type UserRow = RowDataPacket & {
  id: number;
  username: string;
  email: string;
  fullname: string | null;
  role: UserRole;
  password: string;
  status: string;
  balance: number;
  rank: string | null;
  email_verified: number;
  two_factor_enabled: number;
  avatar: string | null;
};

const loginSchema = z.object({
  identifier: z.string().min(3),
  password: z.string().min(6),
});

const registerSchema = z
  .object({
    username: z.string().min(3).max(50),
    email: z.string().email(),
    fullname: z.string().min(2).max(100),
    password: z.string().min(6).max(100),
    confirmPassword: z.string().min(6).max(100),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Mật khẩu xác nhận không khớp.",
    path: ["confirmPassword"],
  });

function sanitizeUser(user: UserRow): SanitizedUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    fullname: user.fullname,
    role: user.role,
    status: user.status,
    balance: Number(user.balance ?? 0),
    rank: user.rank,
    email_verified: Number(user.email_verified ?? 0),
    two_factor_enabled: Number(user.two_factor_enabled ?? 0),
    avatar: buildPublicAssetUrl(user.avatar),
  };
}

async function findUserById(userId: number) {
  const users = await queryRows<UserRow[]>(
    `SELECT
       id,
       username,
       email,
       fullname,
       role,
       password,
       status,
       balance,
       rank,
       email_verified,
       \`2fa_enabled\` AS two_factor_enabled,
       avatar
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [userId],
  );

  return users[0];
}

const router = Router();

router.post(
  "/login",
  asyncHandler(async (request, response) => {
    const payload = loginSchema.parse(request.body);
    const users = await queryRows<UserRow[]>(
      `SELECT
         id,
         username,
         email,
         fullname,
         role,
         password,
         status,
         balance,
         rank,
         email_verified,
         \`2fa_enabled\` AS two_factor_enabled,
         avatar
       FROM users
       WHERE username = ? OR email = ?
       LIMIT 1`,
      [payload.identifier, payload.identifier],
    );

    const user = users[0];

    if (!user) {
      throw new AppError("Tài khoản hoặc mật khẩu không đúng.", 401);
    }

    const isPasswordValid = await comparePassword(payload.password, user.password);

    if (!isPasswordValid) {
      throw new AppError("Tài khoản hoặc mật khẩu không đúng.", 401);
    }

    if (user.status !== "active") {
      throw new AppError("Tài khoản của bạn đang bị khóa hoặc tạm dừng.", 403);
    }

    await executeResult(
      `UPDATE users
       SET last_login = NOW(),
           last_activity = NOW(),
           last_ip = ?
       WHERE id = ?`,
      [getIpAddress(request), user.id],
    );

    const sanitized = sanitizeUser(user);

    response.json({
      message: "Đăng nhập thành công.",
      token: signAccessToken(sanitized),
      user: sanitized,
    });
  }),
);

router.post(
  "/register",
  asyncHandler(async (request, response) => {
    const payload = registerSchema.parse(request.body);
    const duplicatedUsers = await queryRows<RowDataPacket[]>(
      `SELECT id, username, email
       FROM users
       WHERE username = ? OR email = ?`,
      [payload.username, payload.email],
    );

    if (duplicatedUsers.length > 0) {
      throw new AppError("Tên đăng nhập hoặc email đã tồn tại.", 409);
    }

    const passwordHash = await hashPassword(payload.password);
    const result = await executeResult(
      `INSERT INTO users (username, email, password, fullname, role, status, balance, rank, email_verified)
       VALUES (?, ?, ?, ?, 'member', 'active', 0, 'Member', 1)`,
      [payload.username, payload.email, passwordHash, payload.fullname],
    );

    const user = await findUserById(result.insertId);

    if (!user) {
      throw new AppError("Không thể tạo tài khoản mới.", 500);
    }

    const sanitized = sanitizeUser(user);

    response.status(201).json({
      message: "Đăng ký thành công.",
      token: signAccessToken(sanitized),
      user: sanitized,
    });
  }),
);

router.get(
  "/me",
  authMiddleware,
  asyncHandler(async (request, response) => {
    const authUser = request.authUser;

    if (!authUser) {
      throw new AppError("Bạn chưa đăng nhập.", 401);
    }

    const user = await findUserById(authUser.id);

    if (!user) {
      throw new AppError("Không tìm thấy thông tin tài khoản.", 404);
    }

    response.json({
      user: sanitizeUser(user),
    });
  }),
);

export default router;

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export type UserRole =
  | "member"
  | "user"
  | "admin"
  | "sellermarket"
  | "support_tiktok";

export type SanitizedUser = {
  id: number;
  username: string;
  email: string;
  fullname: string | null;
  role: UserRole;
  status: string;
  balance: number;
  rank?: string | null;
  email_verified?: number;
  two_factor_enabled?: number;
  avatar: string | null;
};

export function normalizeLegacyBcrypt(hash: string) {
  if (hash.startsWith("$2y$")) {
    return `$2b$${hash.slice(4)}`;
  }

  return hash;
}

export async function comparePassword(plainText: string, hash: string) {
  return bcrypt.compare(plainText, normalizeLegacyBcrypt(hash));
}

export async function hashPassword(plainText: string) {
  return bcrypt.hash(plainText, 10);
}

export function signAccessToken(user: SanitizedUser) {
  return jwt.sign(user, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, env.JWT_SECRET) as SanitizedUser;
}

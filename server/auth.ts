import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { query } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret-change-me";
const TOKEN_TTL = "12h";

export interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  role: string;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

export async function login(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const { rows } = await query<{
    id: number;
    email: string;
    name: string | null;
    role: string;
    password_hash: string;
  }>("SELECT id, email, name, role, password_hash FROM app_users WHERE email=$1", [
    email.toLowerCase().trim(),
  ]);
  const row = rows[0];
  if (!row) throw new Error("Неверный email или пароль");
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) throw new Error("Неверный email или пароль");

  const user: AuthUser = { id: row.id, email: row.email, name: row.name, role: row.role };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return { token, user };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Требуется авторизация" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
    req.user = { id: decoded.id, email: decoded.email, name: decoded.name, role: decoded.role };
    next();
  } catch {
    res.status(401).json({ error: "Сессия истекла, войдите заново" });
  }
}

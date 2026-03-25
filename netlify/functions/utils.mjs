import { getStore } from "@netlify/blobs";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

export function getJwtSecret() {
  return Netlify.env.get("JWT_SECRET") || "meetsync-dev-secret-change-in-prod";
}

export function getDb(name) {
  return getStore({ name, consistency: "strong" });
}

export function hashPassword(pw) {
  return bcrypt.hashSync(pw, 10);
}

export function checkPassword(pw, hash) {
  return bcrypt.compareSync(pw, hash);
}

export function createToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, getJwtSecret(), { expiresIn: "7d" });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch {
    return null;
  }
}

export function getUserFromRequest(req) {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  if (!match) return null;
  return verifyToken(match[1]);
}

export function jsonResponse(statusCode, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

export function setCookie(name, value, maxAge = 7 * 24 * 3600) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

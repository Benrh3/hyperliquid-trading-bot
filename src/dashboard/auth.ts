// Admin authentication for the dashboard.
//
// If ADMIN_PASSWORD_HASH or SESSION_SECRET is not set, auth is disabled
// entirely: every visitor is treated as a read-only guest (isAdmin = false)
// and the /login route is unavailable. This preserves the previous
// all-public behaviour for anyone who hasn't opted in to auth.

import { createHmac, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";

const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

// ── Login rate limiting ───────────────────────────────────────────────────
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function isLockedOut(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  return !!entry && entry.lockedUntil > Date.now();
}

function recordFailedLogin(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  const count = (entry?.count ?? 0) + 1;
  const lockedUntil = count >= MAX_LOGIN_ATTEMPTS ? now + LOGIN_LOCKOUT_MS : 0;
  loginAttempts.set(ip, { count, lockedUntil });
}

function clearLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

// ── Session secret / config ─────────────────────────────────────────────────

export function isAuthConfigured(): boolean {
  return !!process.env.ADMIN_PASSWORD_HASH && !!process.env.SESSION_SECRET;
}

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET not set");
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

function createSessionToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;

  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { exp: number };
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

/**
 * Sets res.locals.isAdmin based on the session cookie. Never blocks a
 * request — read-only routes remain accessible to everyone regardless
 * of authentication state.
 */
export function isAuthenticated(req: Request, res: Response, next: NextFunction): void {
  res.locals.isAdmin = false;
  res.locals.authConfigured = isAuthConfigured();
  if (res.locals.authConfigured) {
    const token = parseCookies(req.headers.cookie).session;
    if (token && verifySessionToken(token)) {
      res.locals.isAdmin = true;
    }
  }
  next();
}

/**
 * Deny-by-default guard for state-changing requests. Every POST/PUT/PATCH/
 * DELETE is blocked unless the session cookie identifies an admin — the
 * only mutating routes exempted are the ones registered on the auth router
 * before this middleware runs (POST /login). Read-only methods always pass
 * through untouched.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  if (!mutating || res.locals.isAdmin) {
    next();
    return;
  }
  res.status(403).json({ error: "Forbidden: admin authentication required" });
}

export function createAuthRouter(): Router {
  const router = Router();

  router.get("/login", (req, res) => {
    if (!isAuthConfigured()) {
      res.redirect("/");
      return;
    }
    if (res.locals.isAdmin) {
      res.redirect("/");
      return;
    }
    res.render("login", { error: null });
  });

  router.post("/login", async (req, res) => {
    if (!isAuthConfigured()) {
      res.redirect("/");
      return;
    }

    const ip = getClientIp(req);
    if (isLockedOut(ip)) {
      res.status(429).render("login", { error: "Too many failed attempts. Try again in a few minutes." });
      return;
    }

    const { password } = req.body as { password?: string };
    const hash = process.env.ADMIN_PASSWORD_HASH as string;

    const ok = typeof password === "string" && password.length > 0 && await bcrypt.compare(password, hash);
    if (!ok) {
      recordFailedLogin(ip);
      res.status(401).render("login", { error: "Incorrect password" });
      return;
    }
    clearLoginAttempts(ip);

    res.cookie(SESSION_COOKIE, createSessionToken(), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: SESSION_TTL_MS,
    });
    res.redirect("/");
  });

  router.get("/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE);
    res.redirect("/");
  });

  return router;
}

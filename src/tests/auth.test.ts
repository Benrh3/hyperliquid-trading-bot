/**
 * Tests for the dashboard's admin auth guard.
 *
 * Spins up a minimal Express app wired the same way as the real dashboard
 * (isAuthenticated -> auth router -> requireAdmin -> mutating routes) and
 * checks that action endpoints are rejected for non-admins and allowed
 * after a successful login.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "http";
import bcrypt from "bcryptjs";
import { isAuthenticated, requireAdmin, createAuthRouter } from "../dashboard/auth.js";

const TEST_PASSWORD = "correct-password";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);
  process.env.SESSION_SECRET = "test-session-secret";

  const app = express();
  app.set("view engine", "ejs");
  app.set("views", new URL("../dashboard/views", import.meta.url).pathname);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.use(isAuthenticated);
  app.use("/", createAuthRouter());
  app.use(requireAdmin);

  // Stand-ins for the real action endpoints
  app.post("/api/bots", (_req, res) => res.status(201).json({ ok: true, id: "bot-1" }));
  app.delete("/api/bots/:id", (_req, res) => res.json({ ok: true }));
  app.post("/api/bots/:id/mode", (_req, res) => res.json({ ok: true, mode: "live" }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

async function loginAndGetCookie(): Promise<string> {
  const resp = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(TEST_PASSWORD)}`,
    redirect: "manual",
  });
  const setCookie = resp.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0];
}

describe("requireAdmin", () => {
  it("rejects POST /api/bots (add bot) without a session", async () => {
    const resp = await fetch(`${baseUrl}/api/bots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyId: "x", coin: "BTC", timeframe: "1h" }),
    });
    expect(resp.status).toBe(403);
  });

  it("rejects DELETE /api/bots/:id without a session", async () => {
    const resp = await fetch(`${baseUrl}/api/bots/bot-1`, { method: "DELETE" });
    expect(resp.status).toBe(403);
  });

  it("rejects switch-to-LIVE (POST /api/bots/:id/mode) without a session", async () => {
    const resp = await fetch(`${baseUrl}/api/bots/bot-1/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "live" }),
    });
    expect(resp.status).toBe(403);
  });

  it("rejects login with the wrong password", async () => {
    const resp = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=wrong",
    });
    expect(resp.status).toBe(401);
  });

  it("allows mutating requests once authenticated", async () => {
    const cookie = await loginAndGetCookie();

    const addResp = await fetch(`${baseUrl}/api/bots`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ strategyId: "x", coin: "BTC", timeframe: "1h" }),
    });
    expect(addResp.status).toBe(201);

    const modeResp = await fetch(`${baseUrl}/api/bots/bot-1/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ mode: "live" }),
    });
    expect(modeResp.status).toBe(200);

    const deleteResp = await fetch(`${baseUrl}/api/bots/bot-1`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(deleteResp.status).toBe(200);
  });
});

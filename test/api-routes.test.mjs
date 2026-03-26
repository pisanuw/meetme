import test from "node:test";
import assert from "node:assert/strict";

import authHandler from "../netlify/functions/auth.mjs";
import meetingsHandler from "../netlify/functions/meetings.mjs";
import adminHandler from "../netlify/functions/admin.mjs";
import { createToken } from "../netlify/functions/utils.mjs";

async function asJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

test("auth health endpoint responds with checks", async () => {
  const req = new Request("http://localhost:8888/api/auth/health", { method: "GET" });
  const res = await authHandler(req, { params: { 0: "health" } });

  assert.equal(res.status, 200);
  const body = await asJson(res);
  assert.equal(typeof body.ok, "boolean");
  assert.equal(typeof body.checks, "object");
  assert.ok(Array.isArray(body.missing));
});

test("auth me requires authentication", async () => {
  const req = new Request("http://localhost:8888/api/auth/me", { method: "GET" });
  const res = await authHandler(req, { params: { 0: "me" } });

  assert.equal(res.status, 401);
  const body = await asJson(res);
  assert.match(body.error, /Not authenticated/i);
});

test("meetings list requires authentication", async () => {
  const req = new Request("http://localhost:8888/api/meetings", { method: "GET" });
  const res = await meetingsHandler(req, { params: {} });

  assert.equal(res.status, 401);
  const body = await asJson(res);
  assert.match(body.error, /Not authenticated/i);
});

test("admin routes reject non-admin users", async () => {
  process.env.ADMIN_EMAILS = "admin@example.com";
  const token = createToken({ id: "u1", email: "member@example.com", name: "Member" });
  const req = new Request("http://localhost:8888/api/admin/stats", {
    method: "GET",
    headers: { cookie: `token=${token}` },
  });

  const res = await adminHandler(req, { params: { 0: "stats" } });
  assert.equal(res.status, 403);
  const body = await asJson(res);
  assert.match(body.error, /Admin access required/i);
});

test("admin singular user route is no longer supported", async () => {
  process.env.ADMIN_EMAILS = "admin@example.com";
  const token = createToken({ id: "a1", email: "admin@example.com", name: "Admin" });
  const req = new Request("http://localhost:8888/api/admin/user?email=test@example.com", {
    method: "GET",
    headers: { cookie: `token=${token}` },
  });

  const res = await adminHandler(req, { params: { 0: "user" } });
  assert.equal(res.status, 404);
  const body = await asJson(res);
  assert.match(body.error, /not found/i);
});

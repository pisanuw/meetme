import test from "node:test";
import assert from "node:assert/strict";

import {
  createToken,
  verifyToken,
  verifyTokenVerbose,
  getUserFromRequest,
} from "../netlify/functions/utils.mjs";

const SECRET = "test-jwt-secret";
process.env.JWT_SECRET = SECRET;

const USER = { id: "u_123", email: "user@example.com", name: "Test User" };

function requestWith(headers) {
  return new Request("http://localhost:8888/api/me", { headers });
}

test("createToken/verifyToken round-trips the payload", () => {
  const decoded = verifyToken(createToken(USER));
  assert.equal(decoded.id, USER.id);
  assert.equal(decoded.email, USER.email);
  assert.equal(decoded.name, USER.name);
  assert.ok(decoded.iat, "issued-at claim is present");
  assert.ok(decoded.exp > decoded.iat, "expiry claim is after issued-at");
});

test("verifyToken returns null for a tampered token", () => {
  const token = createToken(USER);
  // Flip the final character to invalidate the signature.
  const tampered = token.slice(0, -1) + (token.at(-1) === "x" ? "y" : "x");
  assert.equal(verifyToken(tampered), null);
});

test("verifyToken returns null for malformed/garbage input", () => {
  assert.equal(verifyToken("not-a-jwt"), null);
  assert.equal(verifyToken(""), null);
  assert.equal(verifyToken("a.b.c"), null);
});

test("verifyToken returns null when signed under a different secret", () => {
  const token = createToken(USER);
  process.env.JWT_SECRET = "a-different-secret";
  try {
    assert.equal(verifyToken(token), null);
  } finally {
    process.env.JWT_SECRET = SECRET;
  }
});

test("verifyToken rejects an expired token", () => {
  // jsonwebtoken accepts a negative expiry, producing an already-expired token.
  assert.equal(verifyToken(createToken(USER, "-1s")), null);
});

test("verifyTokenVerbose distinguishes valid, expired, and invalid tokens", () => {
  const valid = verifyTokenVerbose(createToken(USER));
  assert.ok(valid.payload);
  assert.equal(valid.error, null);

  const expired = verifyTokenVerbose(createToken(USER, "-1s"));
  assert.equal(expired.payload, null);
  assert.equal(expired.error, "TokenExpiredError");

  const invalid = verifyTokenVerbose("garbage");
  assert.equal(invalid.payload, null);
  assert.equal(invalid.error, "JsonWebTokenError");
});

test("getUserFromRequest reads the session token from the Cookie header", () => {
  const user = getUserFromRequest(requestWith({ cookie: `token=${createToken(USER)}` }));
  assert.equal(user.email, USER.email);
});

test("getUserFromRequest extracts the token among multiple cookies", () => {
  const token = createToken(USER);
  const user = getUserFromRequest(requestWith({ cookie: `theme=dark; token=${token}; locale=en` }));
  assert.equal(user.id, USER.id);
});

test("getUserFromRequest reads a Bearer token from the Authorization header", () => {
  const user = getUserFromRequest(requestWith({ authorization: `Bearer ${createToken(USER)}` }));
  assert.equal(user.email, USER.email);
});

test("getUserFromRequest prefers the Bearer header and does not fall back to the cookie", () => {
  const bearer = createToken({ ...USER, id: "from-bearer" });
  const cookie = createToken({ ...USER, id: "from-cookie" });

  // A valid Bearer token wins over a valid cookie.
  const both = getUserFromRequest(
    requestWith({ authorization: `Bearer ${bearer}`, cookie: `token=${cookie}` })
  );
  assert.equal(both.id, "from-bearer");

  // An invalid Bearer token is honored as-is (null) without silently falling
  // back to an otherwise-valid cookie.
  const invalidBearer = getUserFromRequest(
    requestWith({ authorization: "Bearer not-a-jwt", cookie: `token=${cookie}` })
  );
  assert.equal(invalidBearer, null);
});

test("getUserFromRequest returns null when no credentials are present", () => {
  assert.equal(getUserFromRequest(requestWith({})), null);
  assert.equal(getUserFromRequest(requestWith({ cookie: "theme=dark" })), null);
  assert.equal(getUserFromRequest(requestWith({ cookie: "" })), null);
});

/*
 * Staging/API smoke checks.
 *
 * Usage:
 *   BASE_URL=https://your-preview.netlify.app npm run smoke:staging
 *
 * Optional:
 *   ADMIN_TOKEN=<jwt> to verify /api/admin/stats returns 200.
 */

const baseUrl = (process.env.BASE_URL || "").trim().replace(/\/$/, "");
if (!baseUrl) {
  console.error("smoke:staging requires BASE_URL, e.g. BASE_URL=https://your-site.netlify.app");
  process.exit(1);
}

function assertCond(cond, message) {
  if (!cond) throw new Error(message);
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`OK  ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    throw err;
  }
}

async function getJson(path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, opts);
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { res, data };
}

(async () => {
  await check("site root responds 200", async () => {
    const res = await fetch(baseUrl);
    assertCond(res.ok, `expected 2xx, got ${res.status}`);
  });

  await check("auth health responds with ok flag", async () => {
    const { res, data } = await getJson("/api/auth/health");
    assertCond(res.status === 200, `expected 200, got ${res.status}`);
    assertCond(typeof data.ok === "boolean", "expected body.ok boolean");
  });

  await check("meetings API denies anonymous callers", async () => {
    const { res } = await getJson("/api/meetings");
    assertCond(res.status === 401, `expected 401, got ${res.status}`);
  });

  const adminToken = (process.env.ADMIN_TOKEN || "").trim();
  if (adminToken) {
    await check("admin stats works with provided token", async () => {
      const { res, data } = await getJson("/api/admin/stats", {
        headers: { cookie: `token=${adminToken}` },
      });
      assertCond(res.status === 200, `expected 200, got ${res.status}`);
      assertCond(typeof data.total_users === "number", "expected stats payload");
    });
  } else {
    console.log("SKIP admin stats check (set ADMIN_TOKEN to enable)");
  }

  console.log("Staging smoke checks completed successfully.");
})().catch(() => process.exit(1));

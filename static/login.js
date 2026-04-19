function sanitizeNextPath(raw) {
  const value = String(raw || "").trim();
  if (!value.startsWith("/")) return "";
  if (value.startsWith("//")) return "";
  return value;
}

const params = new URLSearchParams(window.location.search);
const next = sanitizeNextPath(params.get("next"));

checkAuth().then((user) => {
  if (user) {
    window.location.href = next || "/dashboard.html";
    return;
  }

  const error = params.get("error");
  const errorMap = {
    "invalid-link": "That sign-in link is invalid. Please request a new one.",
    "link-expired": "That sign-in link has expired. Please request a new one.",
    "link-already-used": "That sign-in link has already been used. Please request a new one.",
    "google-not-configured": "Google sign-in is not configured yet.",
    "google-auth-failed": "Google sign-in failed. Please try again.",
    "google-denied": "Google sign-in was cancelled.",
    "google-state-missing":
      "Sign-in session missing — please try again (ensure cookies are enabled).",
    "google-state-expired": "Sign-in session expired — please try again.",
    "google-email-missing": "Your Google account did not share an email address.",
    "google-email-not-verified": "Your Google account email must be verified.",
  };
  if (error && errorMap[error]) {
    showFlash(errorMap[error], "danger");
    const cleanUrl = next ? `/login.html?next=${encodeURIComponent(next)}` : "/login.html";
    window.history.replaceState({}, document.title, cleanUrl);
  }
});

const googleLink = document.querySelector('a[href="/api/auth/google/start"]');
if (googleLink && next) {
  googleLink.href = `/api/auth/google/start?next=${encodeURIComponent(next)}`;
}

const form = document.getElementById("magic-link-form");
if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("email").value.trim();

    const { ok, data } = await apiFetch("/api/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, next }),
    });
    if (ok) {
      window.location.href = "/email-sent.html?email=" + encodeURIComponent(email);
    } else {
      showFlash(data.error || "Could not send sign-in link. Please try again.", "danger");
    }
  });
}

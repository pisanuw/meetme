console.log("index.js: loaded");

checkAuth().then((user) => {
  console.log("index.js: checkAuth returned", { authenticated: !!user });
  if (user) {
    console.log("index.js: authenticated, redirecting to /dashboard.html");
    window.location.href = "/dashboard.html";
    return;
  }

  console.log("index.js: not authenticated, showing login form");
  const params = new URLSearchParams(window.location.search);
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
    window.history.replaceState({}, document.title, "/");
  }
}).catch((err) => {
  console.error("index.js: checkAuth error", err);
});

const form = document.getElementById("magic-link-form");
if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    console.log("index.js: magic-link form submitted");
    const email = document.getElementById("email").value.trim();

    const { ok, data } = await apiFetch("/api/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (ok) {
      console.log("index.js: magic-link request succeeded");
      window.location.href = "/email-sent.html?email=" + encodeURIComponent(email);
    } else {
      console.error("index.js: magic-link request failed", data);
      showFlash(data.error || "Could not send sign-in link. Please try again.", "danger");
    }
  });
} else {
  console.warn("index.js: magic-link-form element not found");
}

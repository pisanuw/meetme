checkAuth().then((user) => {
  if (user) window.location.href = "/dashboard.html";
});

document.getElementById("magic-link-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("name").value.trim();
  const email = document.getElementById("email").value.trim();

  const { ok, data } = await apiFetch("/api/auth/magic-link/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email }),
  });
  if (ok) {
    window.location.href = "/email-sent.html?email=" + encodeURIComponent(email);
  } else {
    showFlash(data.error || "Could not send sign-in link. Please try again.", "danger");
  }
});

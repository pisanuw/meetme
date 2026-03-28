checkAuth().then((user) => {
  if (user) {
    if (!document.getElementById("fb-name").value)
      document.getElementById("fb-name").value = user.name || "";
    if (!document.getElementById("fb-email").value)
      document.getElementById("fb-email").value = user.email || "";
  }
});

document.getElementById("feedback-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("fb-submit");
  btn.disabled = true;
  btn.textContent = "Sending…";

  const payload = {
    name: document.getElementById("fb-name").value.trim(),
    email: document.getElementById("fb-email").value.trim(),
    type: document.getElementById("fb-type").value,
    message: document.getElementById("fb-message").value.trim(),
  };

  const { ok, data } = await apiFetch("/api/auth/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  btn.disabled = false;
  btn.textContent = "✉ Send Feedback";

  if (ok) {
    document.getElementById("feedback-form").hidden = true;
    document.getElementById("feedback-sent").hidden = false;
  } else {
    showFlash(data.error || "Could not send feedback. Please try again.", "danger");
  }
});

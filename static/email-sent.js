checkAuth().then((user) => {
  if (user) window.location.href = "/dashboard.html";
});

const params = new URLSearchParams(window.location.search);
const email = params.get("email");
if (email) {
  document.getElementById("email-msg").textContent =
    `We've sent a sign-in link to ${decodeURIComponent(email)}.`;
}

checkAuth();

const logout = document.getElementById("logout-link");
if (logout) {
  logout.addEventListener("click", async (e) => {
    e.preventDefault();
    await apiFetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  });
}

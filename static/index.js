// index.js — landing page behaviour.
// For now this just renders the static landing content; signed-in redirect
// and anonymous meeting creation are added in later stages.

document.addEventListener("DOMContentLoaded", () => {
  const year = new Date().getFullYear();
  document.querySelectorAll("[data-year]").forEach((el) => {
    el.textContent = String(year);
  });
});

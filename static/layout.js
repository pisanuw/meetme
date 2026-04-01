function renderSharedNav() {
  document.querySelectorAll("nav[data-shared-nav]:not([data-rendered])").forEach((nav) => {
    nav.innerHTML = `
      <div class="nav-inner">
        <a href="/dashboard.html" class="nav-brand"><span class="brand-icon">&#x27F3;</span> MeetMe</a>
        <div class="nav-links" id="nav-auth" hidden>
          <a href="/create-meeting.html" class="btn btn-sm btn-outline-white">+ New Meeting</a>
          <details class="nav-dropdown" id="nav-bookings-menu">
            <summary class="nav-dropdown-trigger">Bookings</summary>
            <div class="nav-dropdown-list" id="nav-bookings-menu-list">
              <a href="/booking-setup.html" class="nav-dropdown-item" id="booking-setup-link">New Booking</a>
              <a href="/booking-links.html" class="nav-dropdown-item" id="booking-links-link">Booking Links</a>
              <a href="/bookings.html" class="nav-dropdown-item" id="bookings-link">My Bookings</a>
            </div>
          </details>
          <span class="nav-user" id="nav-username"></span>
          <a href="#" class="nav-link" id="logout-link">Log out</a>
        </div>
      </div>`;
    nav.dataset.rendered = "true";
  });
}

function renderSharedFooter() {
  const footers = document.querySelectorAll("footer[data-shared-footer]:not([data-rendered])");
  footers.forEach((footer) => {
    const variant = footer.dataset.footerVariant || "default";
    const topLine =
      variant === "admin"
        ? "MeetMe &ndash; Find the perfect time together"
        : 'MeetMe &ndash; Find the perfect time together &mdash; <a href="/feedback.html" class="footer-link-inherit">Send feedback</a>';

    footer.innerHTML = `
      <p>${topLine}</p>
      <p><a href="https://buymeacoffee.com/yusufpisanh" target="_blank" rel="noopener noreferrer" class="footer-link-inherit">&#x2615; Buy me a coffee</a></p>
    `;
    footer.dataset.rendered = "true";
  });
}

document.addEventListener("DOMContentLoaded", () => {
  renderSharedNav();
  renderSharedFooter();
});
// Only render nav/footer after DOMContentLoaded to ensure elements exist
document.addEventListener("DOMContentLoaded", () => {
  renderSharedNav();
  renderSharedFooter();
});

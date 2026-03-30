function renderSharedNav() {
  document.querySelectorAll("nav[data-shared-nav]:not([data-rendered])").forEach((nav) => {
    nav.innerHTML = `
      <div class="nav-inner">
        <a href="/dashboard.html" class="nav-brand"><span class="brand-icon">&#x27F3;</span> MeetMe</a>
        <div class="nav-links" id="nav-auth" hidden>
          <a href="/create-meeting.html" class="btn btn-sm btn-outline-white">+ New Meeting</a>
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

// Run immediately for elements already in the DOM (since script is at the end of <body>)
renderSharedNav();
renderSharedFooter();

document.addEventListener("DOMContentLoaded", () => {
  renderSharedNav();
  renderSharedFooter();
});

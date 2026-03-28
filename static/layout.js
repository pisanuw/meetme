function renderSharedFooter() {
  const footers = document.querySelectorAll("footer[data-shared-footer]");
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
  });
}

document.addEventListener("DOMContentLoaded", () => {
  renderSharedFooter();
});

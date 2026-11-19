/* Copy explicitly displayed portal values only after a customer action. */
if (location.pathname === "/login/callback")
  history.replaceState(null, "", document.body.dataset.returnPath);
document.querySelectorAll("[data-copy-target]").forEach((button) => {
  let feedbackTimer;
  let attempt = 0;
  const label = button.querySelector("span");
  const original = label.textContent;
  button.addEventListener("click", async () => {
    const currentAttempt = ++attempt;
    const field = document.getElementById(button.dataset.copyTarget);
    globalThis.clearTimeout(feedbackTimer);
    button.classList.remove("is-copied");
    label.textContent = original;
    try {
      await navigator.clipboard.writeText(field.value);
      if (currentAttempt !== attempt) return;
      // A chip keeps its text and turns its copy icon into a check mark.
      if (button.dataset.copyFeedback === "icon") {
        button.classList.add("is-copied");
        feedbackTimer = setTimeout(() => {
          if (currentAttempt === attempt) button.classList.remove("is-copied");
        }, 2200);
        return;
      }
      const token = button.dataset.copyTarget === "created-token";
      label.textContent = token ? "✓ Copied" : "Copied";
      if (token) button.classList.add("is-copied");
      feedbackTimer = setTimeout(() => {
        if (currentAttempt !== attempt) return;
        label.textContent = original;
        button.classList.remove("is-copied");
      }, 2200);
    } catch {
      if (currentAttempt !== attempt) return;
      if (button.dataset.copyFeedback === "icon") {
        label.textContent = field.value;
        return;
      }
      field.focus();
      field.select();
      label.textContent = "Select and copy";
    }
  });
});

document.querySelectorAll("[data-dialog-target]").forEach((button) => {
  const dialog = document.getElementById(button.dataset.dialogTarget);
  if (!(dialog instanceof globalThis.HTMLDialogElement)) return;
  button.addEventListener("click", () => {
    dialog.showModal();
    history.replaceState(history.state, "", "#" + dialog.id);
  });
  dialog.querySelector("[data-dialog-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (location.hash === "#" + dialog.id)
      history.replaceState(history.state, "", location.pathname + location.search);
    button.focus();
  });
});
function openUsageFromLocation() {
  const target = document.getElementById(location.hash.slice(1));
  document.querySelectorAll("dialog.usage-dialog[open]").forEach((dialog) => {
    if (dialog !== target) dialog.close();
  });
  if (
    target instanceof globalThis.HTMLDialogElement &&
    target.classList.contains("usage-dialog") &&
    !target.open
  )
    target.showModal();
}
globalThis.addEventListener("hashchange", openUsageFromLocation);
openUsageFromLocation();

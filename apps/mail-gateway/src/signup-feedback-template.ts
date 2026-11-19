/** The same body is used for the owner preview and the gated signup campaign. */
export function renderSignupFeedbackEmail(
  firstName: string | null | undefined,
  sender: { name: string; profileUrl?: string } = { name: "The ohmyho.st team" },
) {
  const name =
    typeof firstName === "string"
      ? Array.from(firstName, (character) => {
          const code = character.codePointAt(0) ?? 0;
          return code < 32 || code === 127 ? " " : character;
        })
          .join("")
          .trim()
          .slice(0, 80)
      : "";
  const greeting = `Hey${name ? ` ${name}` : ""}, ${sender.name} here, the builder behind ohmyho.st.`;
  const feedback =
    "I personally read every reply and answer each one. What you tell me decides what I build or fix next.";
  const question = "What's the one thing that annoyed you so far?";
  const profileUrl = sender.profileUrl ? new URL(sender.profileUrl) : undefined;
  if (
    profileUrl &&
    (profileUrl.protocol !== "https:" || profileUrl.username || profileUrl.password)
  )
    throw new TypeError("Invalid signup feedback sender profile");
  const signature = `Happy building,\n${sender.name}`;
  const postscript =
    "P.S. The ten best replies per month get a year of Paid, free. Honest beats polite.";
  const paragraphs = [
    greeting,
    "I have one question, and one line is enough to answer it:",
    question,
    'Just hit reply. Or tell your agent: "send feedback to ohmyho.st".',
    feedback,
    signature,
    postscript,
  ];
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/gu,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c] ?? c,
    );
  const content = paragraphs
    .map((paragraph) => {
      const body =
        paragraph === signature && profileUrl
          ? `Happy building,<br><a href="${escape(profileUrl.href)}">${escape(sender.name)}</a>`
          : paragraph === feedback
            ? `<u>I personally</u>${escape(paragraph.slice("I personally".length))}`
            : paragraph === question || paragraph === postscript
              ? `<strong>${escape(paragraph)}</strong>`
              : escape(paragraph).replace(/\n/gu, "<br>");
      return `<p style="margin:0 0 20px">${body}</p>`;
    })
    .join("");
  return {
    subject: name ? `${name}, one question` : "One question",
    text: `${paragraphs.map((paragraph) => (paragraph === signature && profileUrl ? `${paragraph} (${profileUrl.href})` : paragraph)).join("\n\n")}\n\n—\nohmyho.st\nHosting for vibe-coded apps.`,
    html: `<!doctype html><html><body style="margin:0;padding:28px 20px;background:#fff;color:#18181b;font:16px/1.5 Arial,sans-serif"><div style="max-width:560px">${content}<div style="margin-top:28px;color:#71717a;font-size:12px;line-height:1.5"><img src="https://ohmyho.st/brand/assets/omega-dark.png" width="24" height="24" alt="" style="vertical-align:middle;margin-right:7px"><a href="https://ohmyho.st" style="color:#18181b;text-decoration:none;font-weight:bold">ohmyho.st</a><br>Hosting for vibe-coded apps.</div></div></body></html>`,
  };
}

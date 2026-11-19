const id = document.querySelector<HTMLInputElement>("#note-id");
const body = document.querySelector<HTMLInputElement>("#note-body");
const result = document.querySelector<HTMLOutputElement>("#note-result");
if (id === null || body === null || result === null) throw new Error("fixture_controls_missing");
for (const [name, method] of [
  ["save", "POST"],
  ["read", "GET"],
  ["delete", "DELETE"],
] as const) {
  const button = document.querySelector(`#note-${name}`);
  if (button === null) throw new Error("fixture_control_missing");
  button.addEventListener("click", async () => {
    const response = await fetch(
      "/api/notes",
      method === "GET"
        ? { cache: "no-store" }
        : {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: id.value, body: body.value }),
          },
    );
    result.textContent = response.ok
      ? JSON.stringify(await response.json())
      : `HTTP ${response.status}`;
  });
}

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main>
      <h1>TanStack Start on ohmyhost</h1>
      <p data-runtime="static">Deterministic static fixture</p>
    </main>
  );
}

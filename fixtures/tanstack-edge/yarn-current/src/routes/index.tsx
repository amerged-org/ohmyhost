import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => <main>TanStack Start 1.168.49 on Yarn</main>,
});

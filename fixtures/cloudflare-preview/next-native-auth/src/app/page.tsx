import Auth from "./auth";
import Notes from "./notes";
export default function Home() {
  return (
    <main>
      <h1>Native Auth preview notes</h1>
      <Auth />
      <Notes />
    </main>
  );
}

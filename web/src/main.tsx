import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 16, maxWidth: 640, margin: "0 auto" }}>
      <h1>Ration Club Recipes</h1>
      <p>Coming soon: browse and edit the community recipe booklet.</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

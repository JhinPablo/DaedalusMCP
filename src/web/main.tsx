import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@xyflow/react/dist/style.css";
import { App } from "./App";
import "./style.css";
import "./chat.css";
import "./appearance.css";
import "./glass/glass.css";
import { initializeAppearance } from "./Appearance";
const AnimatedBackground = React.lazy(() => import("./background/AnimatedBackground"));
initializeAppearance();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <React.Suspense fallback={null}>
      <AnimatedBackground />
    </React.Suspense>
    <App />
  </React.StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import { App } from "./App.tsx";
import { ApiProvider } from "./lib/api/ApiProvider";
import { ThemeProvider } from "./app/ThemeProvider";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <ApiProvider>
          <App />
        </ApiProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);

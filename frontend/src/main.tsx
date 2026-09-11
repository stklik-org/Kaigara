import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import { App } from "./App";
import { ThemeProvider } from "./app/ThemeProvider";
import { ApiProvider } from "./lib/api/ApiProvider";

const container = document.getElementById("root");
if (!container) throw new Error('index.html is missing its <div id="root">.');

createRoot(container).render(
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

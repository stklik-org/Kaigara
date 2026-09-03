import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { ConnectPage } from "./features/connect/ConnectPage";
import { LoadPage } from "./features/load/LoadPage";
import { ComposePage } from "./features/compose/ComposePage";
import { RunPage } from "./features/run/RunPage";
import { AnalyzePage } from "./features/analyze/AnalyzePage";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/connect" replace />} />
        <Route path="connect" element={<ConnectPage />} />
        <Route path="load" element={<LoadPage />} />
        <Route path="compose" element={<ComposePage />} />
        <Route path="run" element={<RunPage />} />
        <Route path="analyze" element={<AnalyzePage />} />
        <Route path="*" element={<Navigate to="/connect" replace />} />
      </Route>
    </Routes>
  );
}

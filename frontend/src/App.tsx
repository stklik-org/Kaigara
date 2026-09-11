import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { ConnectPage } from "./features/connect/ConnectPage";
import { LoadPage } from "./features/load/LoadPage";
import { ComposePage } from "./features/compose/ComposePage";
import { RunPage } from "./features/run/RunPage";
import { AnalyzePage } from "./features/analyze/AnalyzePage";
import { useScenarioStore } from "./features/compose/store/scenarioStore";

/** Where "/" lands. `scenarioStore` boots from a localStorage draft of the timeline last edited;
 *  if one was restored the user was mid-compose last time, so resume there rather than on Connect.
 *  Read once via `getState()` — this is a one-shot redirect, not something to re-render on. */
function InitialRoute() {
  const resumedDraft = useScenarioStore.getState().scenarioName !== "";
  return <Navigate to={resumedDraft ? "/compose" : "/connect"} replace />;
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<InitialRoute />} />
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

import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ComingSoon } from './components/ComingSoon.tsx';
import { Layout } from './components/Layout.tsx';
import { DownloadPage } from './features/download/DownloadPage.tsx';
import { HistoryPage } from './features/history/HistoryPage.tsx';
import { StatusPage } from './features/status/StatusPage.tsx';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/descargar" replace />} />
          <Route path="descargar" element={<DownloadPage />} />
          <Route path="grabar" element={<ComingSoon title="Grabar pantalla" phase={6} />} />
          <Route path="convertir" element={<ComingSoon title="Convertir archivos" phase={5} />} />
          <Route path="historial" element={<HistoryPage />} />
          <Route path="estado" element={<StatusPage />} />
          <Route
            path="*"
            element={
              <section className="page">
                <h1>Página no encontrada</h1>
              </section>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

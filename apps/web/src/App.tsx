import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout.tsx';
import { ConvertPage } from './features/convert/ConvertPage.tsx';
import { DownloadPage } from './features/download/DownloadPage.tsx';
import { HistoryPage } from './features/history/HistoryPage.tsx';
import { RecordingPage } from './features/recording/RecordingPage.tsx';
import { StatusPage } from './features/status/StatusPage.tsx';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/descargar" replace />} />
          <Route path="descargar" element={<DownloadPage />} />
          <Route path="grabar" element={<RecordingPage />} />
          <Route path="convertir" element={<ConvertPage />} />
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

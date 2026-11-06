import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout.tsx';
import { AccountPage } from './features/auth/AccountPage.tsx';
import { AuthGate } from './features/auth/AuthGate.tsx';
import { ConvertPage } from './features/convert/ConvertPage.tsx';
import { DownloadPage } from './features/download/DownloadPage.tsx';
import { HistoryPage } from './features/history/HistoryPage.tsx';
import { RecordingPage } from './features/recording/RecordingPage.tsx';
import { StatusPage } from './features/status/StatusPage.tsx';
import { UsersPage } from './features/users/UsersPage.tsx';

export function App() {
  return (
    <BrowserRouter>
      {/* Login obligatorio (D-100): sin sesión solo se ve la pantalla de ingreso. */}
      <AuthGate>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/descargar" replace />} />
            <Route path="descargar" element={<DownloadPage />} />
            <Route path="grabar" element={<RecordingPage />} />
            <Route path="convertir" element={<ConvertPage />} />
            <Route path="historial" element={<HistoryPage />} />
            <Route path="estado" element={<StatusPage />} />
            <Route path="cuenta" element={<AccountPage />} />
            <Route path="usuarios" element={<UsersPage />} />
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
      </AuthGate>
    </BrowserRouter>
  );
}

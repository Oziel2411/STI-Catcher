import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Inter incluida en la app (sin Google Fonts): las PCs de la red no necesitan internet.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Falta el elemento #root en index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

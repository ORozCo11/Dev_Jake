import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Link } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';
import ErrorBoundary from './components/ErrorBoundary';
import './App.css';
import './ui-foundation.css';

const Login = lazy(() => import('./views/Login'));
const Register = lazy(() => import('./views/Register'));
const Privacy = lazy(() => import('./views/Privacy'));
const Terms = lazy(() => import('./views/Terms'));
const About = lazy(() => import('./views/About'));
const Developers = lazy(() => import('./views/Developers'));
const Support = lazy(() => import('./views/Support'));
const Workspace = lazy(() => import('./views/Workspace'));
const SuperAdminWorkspace = lazy(() => import('./views/SuperAdminWorkspace'));

function AppLoadingFallback() {
  return (
    <main className="app-route-loader" aria-busy="true" aria-live="polite">
      <span className="app-route-loader-spinner" aria-hidden="true" />
      <p>Loading workspace…</p>
    </main>
  );
}

function Unauthorized() {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">Access Control</p>
        <h1>Access denied</h1>
        <p>Your account role does not have permission to view that workspace.</p>
        <Link className="primary-link" to="/login">Return to sign in</Link>
      </section>
    </main>
  );
}

function App() {
  return (
    <Router>
      <ErrorBoundary>
        <a className="skip-link" href="#main-content">Skip to main content</a>
        <Suspense fallback={<AppLoadingFallback />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/about" element={<About />} />
            <Route path="/developers" element={<Developers />} />
            <Route path="/support" element={<Support />} />
            <Route path="/unauthorized" element={<Unauthorized />} />
            <Route
              path="/admin/*"
              element={
                <ProtectedRoute allowedRoles={['Admin']}>
                  <Workspace />
                </ProtectedRoute>
              }
            />
            <Route
              path="/custodian/*"
              element={
                <ProtectedRoute allowedRoles={['Custodian']}>
                  <Workspace />
                </ProtectedRoute>
              }
            />
            <Route
              path="/maintenance/*"
              element={
                <ProtectedRoute allowedRoles={['Maintenance Personnel']}>
                  <Workspace />
                </ProtectedRoute>
              }
            />
            <Route
              path="/superadmin/*"
              element={
                <ProtectedRoute allowedRoles={['Super Admin']}>
                  <SuperAdminWorkspace />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </Router>
  );
}

export default App;

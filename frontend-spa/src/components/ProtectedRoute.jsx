import { useContext } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { AuthContext } from '../context/AuthContextObject';

export const ProtectedRoute = ({ children, allowedRoles }) => {
  const { user, token, loading, sessionError, retrySession, logout } = useContext(AuthContext);
  const location = useLocation();

  // Pause rendering while checking for an existing browser session token
  if (loading) {
    return (
      <div className="fullscreen-loader" role="status" aria-live="polite">
        <span className="fullscreen-loader-spinner" aria-hidden="true">
          <svg viewBox="0 0 50 50" width="56" height="56">
            <circle className="module-loader-track" cx="25" cy="25" r="20" fill="none" strokeWidth="5" />
            <circle className="module-loader-arc" cx="25" cy="25" r="20" fill="none" strokeWidth="5" strokeLinecap="round" />
          </svg>
        </span>
        <p className="fullscreen-loader-label">Verifying your session<span className="module-loader-dots" /></p>
      </div>
    );
  }

  // If not logged in, redirect them immediately back to the main login portal
  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Signed in, but the server couldn't be reached to confirm it — say so and
  // offer a retry, rather than bouncing to Login or Unauthorized.
  if (sessionError && !user) {
    return (
      <main className="auth-page">
        <section className="auth-card" role="alert">
          <p className="eyebrow">VMS</p>
          <h1>Can't reach the server</h1>
          <p className="auth-subtitle">
            Your session is still saved on this device. Check your connection, then try again.
          </p>
          <div className="form-actions" style={{ justifyContent: 'center', marginTop: 16 }}>
            <button type="button" className="ghost-button" onClick={logout}>Sign out</button>
            <button type="button" className="primary-button" onClick={retrySession}>Try again</button>
          </div>
        </section>
      </main>
    );
  }

  // If logged in but lacks the required role, bounce them to an unauthorized alert view.
  // Mirrors Workspace.jsx's hasRole(): check the full `roles` set the account holds, not
  // just the primary `role` string, so a multi-role user isn't bounced from a secondary
  // role's URL that in-page gates would otherwise allow once there.
  const roles = user?.roles;
  const hasAnyAllowedRole = allowedRoles?.some((r) => (
    Array.isArray(roles) && roles.length ? roles.includes(r) : user?.role === r
  ));
  if (allowedRoles && !hasAnyAllowedRole) {
    return <Navigate to="/unauthorized" replace />;
  }

  // Render the page workspace if security validations pass successfully
  return children;
};

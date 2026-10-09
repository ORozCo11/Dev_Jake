import { useContext } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { AuthContext } from '../context/AuthContextObject';
import { Swirling } from './Swirling';

export const ProtectedRoute = ({ children, allowedRoles }) => {
  const { user, token, loading } = useContext(AuthContext);
  const location = useLocation();

  // Pause rendering while checking for an existing browser session token
  if (loading) {
    return (
      <div className="fullscreen-loader" role="status" aria-live="polite">
        <Swirling className="fullscreen-loader-swirling" size={68} />
        <p className="fullscreen-loader-label">Verifying your session<span className="module-loader-dots" /></p>
      </div>
    );
  }

  // If not logged in, redirect them immediately back to the main login portal
  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // If logged in but lacks the required role, bounce them to an unauthorized alert view
  if (allowedRoles && !allowedRoles.includes(user?.role)) {
    return <Navigate to="/unauthorized" replace />;
  }

  // Render the page workspace if security validations pass successfully
  return children;
};

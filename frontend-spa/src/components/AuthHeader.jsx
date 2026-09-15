import { useContext } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';
import { AuthContext } from '../context/AuthContextObject';

const roleRoutes = {
  Admin: '/admin',
  Custodian: '/custodian',
  'Maintenance Personnel': '/maintenance',
  'Super Admin': '/superadmin',
};

// Shared header for the public-facing pages (Login, About, Developers) —
// the sign-in-side counterpart to WorkspaceFooter, so those pages read as
// one connected site instead of disconnected standalone screens.
// extraActions — optional JSX rendered in the right area before the nav
// (e.g. page-specific quick-action buttons like FAQ / Report a Concern).
export default function AuthHeader({ extraActions }) {
  const { user } = useContext(AuthContext);
  // A logged-in user can land here too (e.g. "Visit Support Center" from
  // their workspace footer) — without this, Register/Login would be their
  // only way back, and Login doesn't re-route someone already signed in.
  const dashboardPath = user ? (roleRoutes[user.role] ?? '/admin') : null;

  return (
    <header className="auth-page-header">
      <div className="auth-page-header-inner">
        <Link to={dashboardPath ?? '/login'} className="auth-page-header-brand">
          <Icon name="gear" size={46} className="auth-page-header-gear" filled />
          <div className="auth-page-header-brand-text">
            <span className="vms-wordmark auth-page-header-wordmark">vms</span>
            <span className="auth-page-header-subtext">vehicle management system</span>
          </div>
        </Link>
        <div className="auth-page-header-right">
          {extraActions && <div className="auth-header-extra-actions">{extraActions}</div>}
          <nav className="auth-page-nav">
            <Link to={dashboardPath ?? '/login'}>Home</Link>
            <Link to="/about">About</Link>
            <Link to="/developers">Developers</Link>
            <Link to="/support">Support</Link>
          </nav>
          {dashboardPath ? (
            <Link to={dashboardPath} className="auth-page-header-login-btn">Back to Dashboard</Link>
          ) : (
            <>
              <Link to="/register" className="auth-page-header-register-btn">Register</Link>
              <Link to="/login" className="auth-page-header-login-btn">Login</Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

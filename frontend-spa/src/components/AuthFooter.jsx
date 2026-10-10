import { Link } from 'react-router-dom';

// Footer for the public-facing pages (Login, About, Developers) — no
// logo (the header already carries the brand), a large tagline + social
// icons on the left, real site links on the right, and a copyright/legal
// bar along the bottom. Distinct from WorkspaceFooter, which stays as-is
// for the authenticated app.
export default function AuthFooter() {
  return (
    <footer className="auth-footer">
      <div className="auth-footer-main">
        <div className="auth-footer-brand">
          <h2 className="auth-footer-tagline">A Smarter Way to Manage Your Barangay's Fleet.</h2>
        </div>
        <div className="auth-footer-links">
          {/* Home/About/Support already live in AuthHeader's own nav right
              above this footer — repeating them here was redundant. */}
          <Link to="/developers">Team</Link>
          <Link to="/support#contact">Contact Us</Link>
        </div>
      </div>
      <div className="auth-footer-bottom">
        <p className="auth-footer-copyright">
          © {new Date().getFullYear()} Barangay Vehicle Management System
        </p>
        <div className="auth-footer-legal">
          <Link to="/privacy">Privacy Policy</Link>
          <Link to="/terms">Terms of Service</Link>
        </div>
      </div>
    </footer>
  );
}

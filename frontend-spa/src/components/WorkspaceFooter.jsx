import { Link } from 'react-router-dom';

// Footer for the authenticated app shell (Workspace, Super Admin). Kept
// deliberately quiet: one thin row of copyright + legal links under the
// content column, so it never competes with the operational screens above.
// Help & Support / Contact Us live in the account (profile) menu instead.
// Public pages (Login, About, Support, etc.) use AuthFooter.
export default function WorkspaceFooter() {
  return (
    <footer className="workspace-footer">
      <p className="workspace-footer-copyright">
        © {new Date().getFullYear()} Barangay Vehicle Management System. All rights reserved.
      </p>
      <nav className="workspace-footer-links" aria-label="Legal">
        <Link to="/privacy">Privacy Policy</Link>
        <Link to="/terms">Terms of Service</Link>
      </nav>
    </footer>
  );
}

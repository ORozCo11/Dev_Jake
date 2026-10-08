import { Link } from 'react-router-dom';
import Icon from './Icon';

// Footer for the authenticated app shell (Workspace, Super Admin) — its own
// "Visit Support Center" / "Contact Us" buttons live here since a logged-in
// user is the more likely audience for those. Public pages (Login, About,
// Support, etc.) use the separate, lighter AuthFooter instead.
export default function WorkspaceFooter() {
  return (
    <footer className="workspace-footer">
      <div className="workspace-footer-brand">
        <div className="workspace-footer-wordmark">
          <Icon name="gear" size={36} className="workspace-footer-gear-icon" filled />
          <span className="vms-wordmark vms-wordmark-md workspace-footer-vms-text">vms</span>
        </div>
        <p className="workspace-footer-tagline">A System to Manage Your Barangay's Fleet.</p>
      </div>
      <div className="workspace-footer-actions">
        <div className="workspace-footer-buttons">
          <Link to="/support" className="workspace-footer-btn workspace-footer-btn-light">Visit Support Center</Link>
          <Link to="/support#contact" className="workspace-footer-btn workspace-footer-btn-dark">Contact Us</Link>
        </div>
        <p className="workspace-footer-copyright">
          © {new Date().getFullYear()} Barangay Vehicle Management System. All rights reserved.
        </p>
        <div className="workspace-footer-links">
          <Link to="/privacy">Privacy Policy</Link>
          <Link to="/terms">Terms of Service</Link>
        </div>
      </div>
    </footer>
  );
}

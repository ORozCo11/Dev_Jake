import AuthHeader from '../components/AuthHeader';
import AuthFooter from '../components/AuthFooter';
import Icon from '../components/Icon';

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8v4l3 3" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

const FEATURES = [
  { icon: <Icon name="vehicle" size={22} />, title: 'Fleet Management', desc: "Track every vehicle's availability, condition, and status in real time." },
  { icon: <Icon name="wrench" size={22} />, title: 'Maintenance Workflow', desc: 'From a reported issue, through inspection and repair, to a verified return to service.' },
  { icon: <Icon name="calendar" size={22} />, title: 'Scheduling', desc: 'Plan preventive maintenance ahead of time, including recurring service.' },
  { icon: <Icon name="pin" size={22} />, title: 'Vehicle Location', desc: 'See exactly where every vehicle is stationed on an interactive map.' },
  { icon: <Icon name="alert" size={22} />, title: 'Issue Reports', desc: 'Log and track problems from the moment they are reported to resolution.' },
  { icon: <UsersIcon />, title: 'Role-Based Access', desc: 'Admin, Custodian, and Maintenance Personnel each see only what they need.' },
  { icon: <ClockIcon />, title: 'Activity History', desc: 'A complete, automatic timeline of every action taken across the fleet.' },
  { icon: <Icon name="clipboard" size={22} />, title: 'Reports', desc: 'Printable summaries for oversight, audits, and planning ahead.' },
];

export default function About() {
  return (
    <div className="auth-page-shell">
      <AuthHeader />

      <main className="auth-hero">
        <div className="auth-hero-inner">
          <p className="auth-hero-eyebrow">Barangay VMS</p>
          <h1 className="auth-hero-title">About the System</h1>
          <p className="auth-hero-subtitle">
            The Barangay Vehicle Management System (VMS) is a fleet management
            platform built for a barangay's emergency response vehicles —
            ambulances, fire trucks, and rescue boats. It answers two
            questions at any moment: is a vehicle ready to respond right now,
            and what is being done to keep it that way.
          </p>

          <div className="about-hero-body">
            <h3>What it covers</h3>
            <ul>
              <li>Vehicle availability and physical condition, tracked independently</li>
              <li>A structured maintenance workflow — from a reported issue, through inspection and repair, to a verified return to service</li>
              <li>Preventive maintenance scheduling, including recurring service</li>
              <li>Fleet-wide readiness and reliability signals for planning ahead</li>
            </ul>

            <h3>Who it's for</h3>
            <p>
              Three roles share the workflow: an <strong>Admin</strong> who
              oversees the fleet, a <strong>Custodian</strong> who inspects
              vehicles and verifies repairs, and <strong>Maintenance
              Personnel</strong> who carry out the work — each accountable for
              their part of the process.
            </p>
          </div>
        </div>
      </main>

      <section className="about-features">
        <div className="about-features-inner">
          <h2 className="about-features-title">A Smarter Way to Manage Your Barangay's Fleet</h2>
          <div className="about-features-grid">
            {FEATURES.map((f) => (
              <div className="about-feature-card" key={f.title}>
                <span className="about-feature-icon">{f.icon}</span>
                <p className="about-feature-name">{f.title}</p>
                <p className="about-feature-desc">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <AuthFooter />
    </div>
  );
}

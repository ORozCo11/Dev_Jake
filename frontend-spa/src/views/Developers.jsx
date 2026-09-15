import { useState } from 'react';
import { Link } from 'react-router-dom';
import AuthHeader from '../components/AuthHeader';
import AuthFooter from '../components/AuthFooter';

// Photo cutouts are transparent PNGs, normalized to the same canvas size and
// head position (see public/team/*-cutout.png) so the blue glow and hover
// role tag line up consistently across cards. `photoWhiteBg`, when present,
// is a real photo shown by default that crossfades into the transparent
// cutout on hover/focus; without it, the frame's own white background
// stands in for the default look instead.
const TEAM = [
  { name: 'Precious Dignos', role: 'Project Manager / QA Specialist', photo: '/team/precious-cutout.png' },
  { name: 'John Paul Orozco', role: 'Project Lead / Full-Stack Developer', photo: '/team/john-paul-cutout.png' },
  { name: 'Justine Mae Belia', role: 'Documentation / QA Specialist', photo: '/team/justine-cutout.png' },
  {
    name: 'Jake Engana',
    role: 'Backend Developer / UI-UX Designer',
    photo: '/team/jake-cutout.png',
    photoWhiteBg: '/team/jake-whitebg.jpg',
  },
];

const PER_PAGE = 4;

function initialsOf(name) {
  return name.split(' ').map((n) => n[0]).join('').slice(0, 2);
}

// Purely decorative — the tall faded arrow graphics flanking the hero,
// solid near the arrowhead and fading out along the shaft.
function DecoArrow({ className, gradientId }) {
  return (
    <svg className={className} viewBox="0 0 100 400" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#bfe3fb" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#bfe3fb" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points="50,0 92,58 66,58 66,400 34,400 34,58 8,58" fill={`url(#${gradientId})`} />
    </svg>
  );
}

export default function Developers() {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(TEAM.length / PER_PAGE));
  const visible = TEAM.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

  const pageActions = (
    <div className="dev-header-actions">
      <Link to="/support" className="dev-header-action-btn">Report a Concern</Link>
      <a href="#faq" className="dev-header-action-btn">FAQ</a>
    </div>
  );

  return (
    <div className="auth-page-shell" style={{ overflow: 'hidden', height: '100vh' }}>
      <AuthHeader extraActions={pageActions} />

      <main className="auth-hero">
        <DecoArrow className="dev-team-deco-arrow dev-team-deco-arrow-left" gradientId="devArrowLeft" />
        <DecoArrow className="dev-team-deco-arrow dev-team-deco-arrow-right" gradientId="devArrowRight" />
        <div className="auth-hero-inner">
          <p className="auth-hero-eyebrow">Barangay VMS</p>
          <h1 className="auth-hero-title">Meet the Developers</h1>
          <p className="auth-hero-subtitle">
            This system was built as a capstone project by a small, dedicated team
            committed to giving barangays a better way to manage their vehicle fleet.
          </p>

          <div className="dev-team-carousel">
            {totalPages > 1 && (
              <button
                type="button"
                className="dev-team-arrow"
                onClick={() => setPage((p) => (p - 1 + totalPages) % totalPages)}
                aria-label="Previous team members"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
              </button>
            )}

            <div className="dev-team-grid">
              {visible.map((member, i) => (
                <div
                  className="dev-team-card"
                  key={`${page}-${i}`}
                  tabIndex="0"
                  aria-label={`${member.name}, ${member.role}`}
                >
                  <p className="dev-team-role-tag">{member.role}</p>
                  <div className="dev-team-photo-frame">
                    {member.photo ? (
                      <>
                        {member.photoWhiteBg && (
                          <img
                            className="dev-team-photo-whitebg"
                            src={member.photoWhiteBg}
                            alt=""
                            aria-hidden="true"
                          />
                        )}
                        <img className="dev-team-photo-img" src={member.photo} alt={member.name} />
                      </>
                    ) : (
                      <div className="dev-team-photo-placeholder">{initialsOf(member.name)}</div>
                    )}
                  </div>
                  <p className="dev-team-name">{member.name}</p>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <button
                type="button"
                className="dev-team-arrow"
                onClick={() => setPage((p) => (p + 1) % totalPages)}
                aria-label="Next team members"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
              </button>
            )}
          </div>

          {totalPages > 1 && (
            <div className="dev-team-dots">
              {Array.from({ length: totalPages }).map((_, i) => (
                <button
                  key={i}
                  type="button"
                  className={`dev-team-dot${i === page ? ' is-active' : ''}`}
                  onClick={() => setPage(i)}
                  aria-label={`Go to page ${i + 1}`}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <AuthFooter />
    </div>
  );
}

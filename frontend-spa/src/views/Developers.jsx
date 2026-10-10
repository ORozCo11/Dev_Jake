import { useState } from 'react';
import AuthHeader from '../components/AuthHeader';
import AuthFooter from '../components/AuthFooter';
import Icon from '../components/Icon';

// TODO: replace the placeholder team info below with your actual capstone
// group's names, roles, and (optionally) contact/GitHub links.
//
// To add a real photo: drop the image file in `public/team/` (e.g.
// `public/team/juan.jpg`) and set `photo: '/team/juan.jpg'` below. Leaving
// `photo: null` keeps the initials placeholder shown now.
const TEAM = [
  { name: 'Precious Dignos', role: 'Project Manager / QA Specialist', photo: '/team/precious-dignos.jpg' },
  { name: 'John Paul Orozco', role: 'Project Lead / Full-Stack Developer', photo: '/team/paul-orozco.jpg' },
  { name: 'Justine Mae Belia', role: 'Documentation / QA Specialist', photo: '/team/justine-mae-belia.jpg' },
  { name: 'Jake Engana', role: 'Backend Developer / UI-UX Designer', photo: '/team/jake-engana.jpg' },
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

  return (
    <div className="auth-page-shell">
      <AuthHeader />

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
                <Icon name="chevronRight" size={22} style={{ transform: 'rotate(180deg)' }} />
              </button>
            )}

            <div className="dev-team-grid">
              {visible.map((member, i) => (
                <div className="dev-team-card" key={`${page}-${i}`}>
                  <div className="dev-team-photo">
                    {member.photo ? (
                      <img src={member.photo} alt={member.name} />
                    ) : (
                      <div className="dev-team-photo-placeholder">{initialsOf(member.name)}</div>
                    )}
                    <div className="dev-team-caption">
                      <p className="dev-team-name">{member.name}</p>
                      <p className="dev-team-role">{member.role}</p>
                    </div>
                  </div>
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
                <Icon name="chevronRight" size={22} />
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

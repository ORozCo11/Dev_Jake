import Icon from '../../components/Icon';
import { SEVERITY_GUIDE, issueTicketState } from './issueState';

// Small, eagerly-loaded Issue Reports building blocks (badges, the form's
// severity guide, the list's explainer and filtered-empty state). Kept apart
// from issues.jsx so the table columns and form fields can import them
// without pulling the lazily-loaded detail page into the main bundle.

// =========================================================================
// TICKET STATE / SEVERITY — shared by the Issue Reports table and detail page
// =========================================================================

// Text + icon pill for issueTicketState(). When `onViewTicket` is given and
// a ticket exists, the ticket number becomes a real link-button beside it.
export function IssueTicketStateBadge({ issue, onViewTicket, showSub = true }) {
  const state = issueTicketState(issue);
  const ticket = issue?.maintenance_ticket;
  return (
    <span className="p23-ticket-state">
      <span className={`p23-pill is-${state.tone}`} title={state.hint}>
        <Icon name={state.icon} size={13} />
        <span>{state.label}</span>
      </span>
      {showSub && state.sub && <small className="p23-pill-sub">{state.sub}</small>}
      {ticket && onViewTicket && (
        <button
          type="button"
          className="p23-link-btn"
          onClick={(e) => { e.stopPropagation(); onViewTicket({ ticket_id: ticket.ticket_id }); }}
          aria-label={`Open Ticket #${ticket.ticket_id}`}
        >
          Ticket #{ticket.ticket_id}
        </button>
      )}
    </span>
  );
}

// High / Medium / Low with its own icon and distinct colour (the shared
// priority-high/-medium badge classes render High and Medium identically),
// so severity is readable from the word and the icon, not just the hue.
const SEVERITY_META = {
  High: { icon: 'alert', tone: 'danger' },
  Medium: { icon: 'flag', tone: 'warning' },
  Low: { icon: 'info', tone: 'info' },
};


export function IssueSeverityBadge({ value }) {
  if (!value) return <span className="muted">-</span>;
  const meta = SEVERITY_META[value] ?? { icon: 'info', tone: 'neutral' };
  return (
    <span className={`p23-pill is-${meta.tone}`} title={SEVERITY_GUIDE[value]}>
      <Icon name={meta.icon} size={13} />
      <span>{value}</span>
    </span>
  );
}

// Plain-language guide shown under the report form's Severity select, so
// reporters pick a level by example instead of guessing from a colour.
export function SeverityGuide({ levels = ['High', 'Medium', 'Low'], selected }) {
  return (
    <div className="p23-severity-guide" aria-label="How to choose a severity level">
      <p className="p23-severity-guide-title">How to choose a severity</p>
      <ul>
        {levels.filter((l) => SEVERITY_GUIDE[l]).map((level) => (
          <li key={level} className={selected === level ? 'is-selected' : undefined}>
            <IssueSeverityBadge value={level} />
            <span>{SEVERITY_GUIDE[level]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// One-paragraph explainer at the top of Issue Reports: what belongs on this
// list, and how a report differs from a maintenance-ticket proposal.
export function IssueReportsIntro({ canPropose }) {
  return (
    <div className="p23-intro" role="note">
      <Icon name="info" size={16} />
      <div>
        <p>
          <strong>Issue reports</strong> record a problem someone noticed on a vehicle.
          A <strong>maintenance ticket</strong> is the approved repair job that fixes it.
        </p>
        <p className="p23-intro-sub">
          {canPropose
            ? 'Use “Propose Ticket” when a vehicle needs repair — it files the report for you and asks Admin to approve the work. '
            : 'Reports wait here until a ticket is proposed and approved. '}
          Once Admin approves, the report moves to the Custodian’s My Tickets, so this list only shows reports without an approved ticket.
        </p>
      </div>
    </div>
  );
}

// Empty state that says WHICH filters emptied the list (instead of the
// generic "no issues" line) and offers a one-click way back.
export function IssueFilteredEmpty({ severity = [], statuses = [], search = '', onClear }) {
  const sevText = severity.length ? `${severity.join(' / ')}-severity ` : '';
  const statusText = statuses.length ? ` with status ${statuses.join(' or ')}` : '';
  return (
    <span className="p23-filtered-empty" role="status">
      <span className="p23-filtered-empty-title">
        No {sevText}reports{statusText} match {search ? <>“{search}” and </> : null}these filters.
      </span>
      {onClear && (
        <button type="button" className="ghost-button p23-clear-btn" onClick={onClear}>
          <Icon name="close" size={14} /> Clear filters
        </button>
      )}
    </span>
  );
}

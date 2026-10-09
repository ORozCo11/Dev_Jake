import Icon from '../../components/Icon';

// Condition Monitoring helpers — the result badge, the "this check opened a
// ticket" cell, the page explainer, and its filter-aware empty state.

// One tone per result, matching CONDITION_STAT_CARDS and the shared
// .status-badge colours (Good green, Needs Inspection amber, Needs Repair
// red, Not Checked grey) — always paired with an icon and the word itself.
const CONDITION_META = {
  Good: { icon: 'checkCircle', tone: 'success', hint: 'Physical condition looked good at the time of this check. This is not a readiness verification.' },
  'Needs Inspection': { icon: 'search', tone: 'warning', hint: 'Something should be looked at more closely.' },
  'Needs Repair': { icon: 'wrench', tone: 'danger', hint: 'A problem was found that needs repair.' },
  'Not Checked': { icon: 'eyeOff', tone: 'neutral', hint: 'No condition check has been recorded for this vehicle yet.' },
};

export function ConditionResultBadge({ value, isLatest = false }) {
  const meta = CONDITION_META[value] ?? { icon: 'info', tone: 'neutral', hint: undefined };
  return (
    <span className="p23-cond-result">
      <span className={`p23-pill is-${meta.tone}`} title={meta.hint}>
        <Icon name={meta.icon} size={13} />
        <span>{value ?? '-'}</span>
      </span>
      {isLatest && <small className="p23-latest-tag" title="Most recent check on file for this vehicle">Latest</small>}
    </span>
  );
}

// The ticket a check was turned into (resulting_ticket, eager-loaded by the
// API), as a link — or a dash when none was ever opened from it.
export function ConditionTicketCell({ row, onViewTicket }) {
  const ticket = row.resulting_ticket;
  if (!ticket) return <span className="muted" aria-label="No ticket">-</span>;
  return (
    <span className="p23-ticket-state">
      <span className="p23-pill is-info" title="A maintenance ticket was opened from this check">
        <Icon name="ticket" size={13} />
        <span>Ticket created</span>
      </span>
      {onViewTicket ? (
        <button
          type="button"
          className="p23-link-btn"
          onClick={(e) => { e.stopPropagation(); onViewTicket({ ticket_id: ticket.ticket_id }); }}
          aria-label={`Open Ticket #${ticket.ticket_id}${ticket.status ? ` (${ticket.status})` : ''}`}
        >
          Ticket #{ticket.ticket_id}
        </button>
      ) : <small className="p23-pill-sub">Ticket #{ticket.ticket_id}</small>}
      {ticket.status && <small className="p23-pill-sub">{ticket.status}</small>}
    </span>
  );
}

export function ConditionMonitoringIntro() {
  return (
    <div className="p23-intro" role="note">
      <Icon name="info" size={16} />
      <div>
        <p>
          A <strong>condition check</strong> is a routine look at a vehicle’s physical state (Good or Needs Repair).
          It is not a <strong>Readiness Check</strong> — a “Good” result does not mean the vehicle is verified ready to respond.
        </p>
        <p className="p23-intro-sub">
          Readiness is confirmed separately with a Readiness Check from the vehicle list. Rows tagged “Latest” are each vehicle’s most recent check.
        </p>
      </div>
    </div>
  );
}

export function ConditionFilteredEmpty({ results = [], search = '', onClear }) {
  const resultText = results.length ? ` with result ${results.join(' or ')}` : '';
  return (
    <span className="p23-filtered-empty" role="status">
      <span className="p23-filtered-empty-title">
        No condition checks{resultText} match {search ? <>“{search}” and </> : null}these filters.
      </span>
      {onClear && (
        <button type="button" className="ghost-button p23-clear-btn" onClick={onClear}>
          <Icon name="close" size={14} /> Clear filters
        </button>
      )}
    </span>
  );
}

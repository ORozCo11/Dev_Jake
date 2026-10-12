// Pure helpers for Issue Reports (kept out of issues.jsx so that file only
// exports components).

// Where an issue report sits relative to the maintenance ticket workflow,
// as one plain-language label + icon (never colour alone). Derived purely
// from what the issue payload already carries: its own status and the
// eager-loaded maintenance_ticket (if any).
export function issueTicketState(issue) {
  const ticket = issue?.maintenance_ticket;
  if (!ticket) {
    if (issue?.status === 'Resolved') {
      return /^Dismissed by/i.test(issue.remarks ?? '')
        ? { key: 'dismissed', label: 'Dismissed', icon: 'archive', tone: 'neutral', hint: 'Closed without a ticket — see the remarks for the reason.' }
        : { key: 'resolved', label: 'Resolved', icon: 'checkCircle', tone: 'success', hint: 'Marked resolved without a maintenance ticket.' };
    }
    return { key: 'none', label: 'No ticket yet', icon: 'info', tone: 'neutral', hint: 'Nobody has proposed a maintenance ticket for this report yet.' };
  }
  switch (ticket.status) {
    case 'Pending Approval':
      return { key: 'proposed', label: 'Ticket proposed', sub: 'Pending approval', icon: 'ticket', tone: 'info', hint: 'A ticket was proposed and is waiting for Admin approval.' };
    case 'Declined':
      return { key: 'declined', label: 'Proposal declined', icon: 'close', tone: 'danger', hint: 'Admin declined the ticket proposal. A new one can be proposed if the problem remains.' };
    case 'Cancelled':
      return { key: 'cancelled', label: 'Ticket cancelled', icon: 'close', tone: 'neutral', hint: 'The ticket for this report was cancelled.' };
    case 'Closed':
    case 'Done':
      return { key: 'resolved', label: 'Resolved', sub: 'Ticket closed', icon: 'checkCircle', tone: 'success', hint: 'The repair ticket for this report has been closed.' };
    default:
      return { key: 'active', label: 'Ticket active', sub: ticket.status, icon: 'wrench', tone: 'warning', hint: 'Repair work is in progress on the linked ticket.' };
  }
}

// Short, example-led definition of each severity level — shown in the
// report form and as the severity badge's tooltip.
export const SEVERITY_GUIDE = {
  High: 'Unsafe to drive or can’t respond — e.g. brake failure, engine won’t start, overheating, major fluid leak.',
  Medium: 'Still drivable but needs repair soon — e.g. dashboard warning light, weak battery, worn tyres.',
  Low: 'Minor or cosmetic, no effect on response — e.g. small dent, torn seat, interior light out.',
};

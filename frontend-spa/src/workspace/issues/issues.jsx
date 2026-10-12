import { useContext, useEffect, useMemo, useState } from 'react';
import useDepsChanged from '../../hooks/useDepsChanged';
import api from '../../api/axios';
import Icon from '../../components/Icon';
import { VehicleLocationMap } from '../../components/lazy';
import { SolidPieChart } from '../../components/lazy';
import { ModuleLoader, ModulePanel, QuietDate, SolidPieLegend, StatusBadge, TicketStatusBadge, UserAvatarName } from '../components/ui';
import { RowActionsContext } from '../contexts';
import { formatDate, resolvePhotoUrl, timeAgo } from '../lib/format';
import { canDo } from '../lib/permissions';
import { ISSUE_STATUS_COLORS } from '../lib/statCards';
import { issueNeedsTicket } from '../lib/workflow';
import { IssueSeverityBadge, IssueTicketStateBadge } from './issueBadges';

// Full-page issue detail — mirrors the vehicle/ticket profile pages so every
// "View" action opens its own page rather than a modal, consistently for all roles.
// Fetches by ID rather than looking the issue up in an already-loaded list —
// a pure Custodian's own list is filtered to "mine", but a "View" link from
// the duplicate-issue warning is specifically for a report FILED BY SOMEONE
// ELSE on the same vehicle, which that filtered list would never contain.
export function IssueViewPage({ issueId, allIssues = [], allHubs = [], user, onCreateTicketFromIssue, onDismissIssue, onRecommendTicket }) {
  const actions = useContext(RowActionsContext);
  const [issue, setIssue] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // Recurrence used to only ever surface AFTER a ticket was created — one
  // step too late to change the decision. Checking it here means Admin sees
  // "this fault came back a 3rd time" while still deciding whether to open
  // one, not in a notification once it already exists.
  const [recurrenceResult, setRecurrence] = useState(null);
  const issueVehicleId = issue?.vehicle_id;
  const issueType = issue?.issue_type;
  const recurrence = issueVehicleId ? recurrenceResult : null;

  if (useDepsChanged([issueId])) setLoading(true);

  useEffect(() => {
    let cancelled = false;
    api.get(`/issues/${issueId}`)
      .then((response) => { if (!cancelled) { setIssue(response.data); setNotFound(false); } })
      .catch(() => { if (!cancelled) setNotFound(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [issueId]);

  useEffect(() => {
    if (!issueVehicleId) return undefined;
    let cancelled = false;
    api.get(`/vehicles/${issueVehicleId}/recurrence`, { params: { issue_type: issueType, title: issueType } })
      .then((r) => { if (!cancelled) setRecurrence(r.data); })
      .catch(() => { if (!cancelled) setRecurrence(null); });
    return () => { cancelled = true; };
  }, [issueVehicleId, issueType]);

  const hub = allHubs.find((h) => h.name === issue?.vehicle?.current_location);

  // This vehicle's full issue-report history, broken down by status — reuses
  // the already-loaded issues list, no extra API call.
  const historySegments = useMemo(() => {
    if (!issueVehicleId) return [];
    const forThisVehicle = allIssues.filter((i) => i.vehicle_id === issueVehicleId);
    return Object.entries(ISSUE_STATUS_COLORS).map(([label, color]) => ({
      label,
      color,
      value: forThisVehicle.filter((i) => i.status === label).length,
    }));
  }, [allIssues, issueVehicleId]);
  const historyTotal = historySegments.reduce((sum, s) => sum + s.value, 0);

  if (loading) return <ModuleLoader label="Loading issue" />;

  if (notFound || !issue) {
    return (
      <ModulePanel description="This issue report could not be found — it may have been deleted.">
      </ModulePanel>
    );
  }

  return (
    <ModulePanel description="Full details of this reported vehicle issue.">
      <div className="vehicle-profile-header">
        <div className="vehicle-profile-identity">
          <span className="ticket-detail-id">Issue #{issue.issue_report_id}</span>
          <h3 className="ticket-detail-title">{issue.issue_type}</h3>
          <div className="ticket-detail-meta">
            <IssueSeverityBadge value={issue.severity_level} />
            <StatusBadge value={issue.status} />
            <IssueTicketStateBadge issue={issue} showSub={false} />
          </div>
        </div>
        {/* A repair starts only as a Custodian's proposal, which the Admin
            then approves or declines — so this is the only action here. */}
        {onDismissIssue && canDo(user, 'issue.dismiss') && issueNeedsTicket(issue) && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ghost-button btn-delete-action" type="button" onClick={() => onDismissIssue(issue)}><Icon name="close" size={14} /> Dismiss</button>
          </div>
        )}
        {onRecommendTicket && canDo(user, 'issue.recommend_ticket') && ['Pending', 'Under Review'].includes(issue.status) && !issue.maintenance_ticket && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ghost-button btn-confirm-action" type="button" onClick={() => onRecommendTicket(issue)}><Icon name="ticket" size={14} /> Recommend Maintenance Ticket</button>
          </div>
        )}
        {onCreateTicketFromIssue && (canDo(user, 'ticket.create') || canDo(user, 'ticket.propose')) && ['Pending', 'Under Review'].includes(issue.status) && !issue.maintenance_ticket && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ghost-button btn-confirm-action" type="button" onClick={() => onCreateTicketFromIssue(issue)}><Icon name="ticket" size={14} /> {canDo(user, 'ticket.propose') ? 'Propose Ticket' : 'Create Ticket'}</button>
          </div>
        )}
      </div>

      {onDismissIssue && canDo(user, 'issue.dismiss') && !issueNeedsTicket(issue) && (
        <p className="p23-why-note">
          <Icon name="info" size={14} />
          <span>
            {issue.maintenance_ticket
              ? `This report can’t be dismissed because Ticket #${issue.maintenance_ticket.ticket_id} was opened from it — close or decline that ticket instead.`
              : 'This report is already closed, so there is nothing left to dismiss.'}
          </span>
        </p>
      )}

      {recurrence && recurrence.count > 0 && (
        <div className="ticket-alert-banner formaint" style={{ marginBottom: 16 }}>
          <Icon name="alert" size={16} />
          <span>
            {/* Same ordinal-suffix pattern as the ticket detail page's own
                "Recurring — Nth time" badge — recurrence.count is the count
                of PRIOR occurrences, same semantics as ticket.recurrence_count
                there, so it indexes the same way. */}
            <strong>This is the {recurrence.count + 1}{['st', 'nd', 'rd'][recurrence.count] ?? 'th'} time</strong> "{issue.issue_type}" has come up on this vehicle in the last 90 days
            {recurrence.last_occurred && (
              <> — last fixed via {recurrence.last_type === 'record' ? 'Maintenance Record' : 'Ticket'} #{recurrence.last_id} on {formatDate(recurrence.last_occurred)}</>
            )}
            . Consider a deeper fix or a decommission review rather than another routine repair.
          </span>
        </div>
      )}

      <div className="issue-view-dash">
        <div className="issue-view-main">
          <section className="veh-card issue-view-info">
            <div className="veh-card-head"><Icon name="alert" size={16} /><h4>Issue Information</h4></div>
            <div className="issue-view-info-body">
              {issue.vehicle?.photo_url && (
                <div className="issue-view-vehicle-photo">
                  <img src={resolvePhotoUrl(issue.vehicle.photo_url)} alt={issue.vehicle.vehicle_name} />
                </div>
              )}
              <div className="issue-view-identity">
                <div>
                  <span className="veh-remarks-label">Vehicle</span>
                  {issue.vehicle ? (
                    actions?.viewVehicle ? (
                      <button type="button" className="issue-view-identity-link" onClick={() => actions.viewVehicle(issue.vehicle)}>
                        {issue.vehicle.vehicle_name}
                      </button>
                    ) : <p className="issue-view-identity-value">{issue.vehicle.vehicle_name}</p>
                  ) : <p className="issue-view-identity-value">-</p>}
                  {issue.vehicle?.plate_number && <span className="muted"> ({issue.vehicle.plate_number})</span>}
                </div>
                <div>
                  <span className="veh-remarks-label">Reported By</span>
                  <div style={{ marginTop: 4 }}><UserAvatarName user={issue.reported_by} /></div>
                </div>
              </div>

              <div className="issue-view-facts">
                <p><strong>Issue Type:</strong> {issue.issue_type}</p>
                <p><strong>Severity:</strong> <IssueSeverityBadge value={issue.severity_level} /></p>
                <p><strong>Status:</strong> <StatusBadge value={issue.status} /></p>
                {issue.vehicle?.status && (
                  <p><strong>Vehicle:</strong> <StatusBadge value={issue.vehicle.status} /></p>
                )}
                {issue.maintenance_ticket && (
                  <p>
                    <strong>Linked Ticket:</strong>{' '}
                    {actions?.viewTicket ? (
                      <button type="button" className="issue-view-identity-link" style={{ display: 'inline', fontSize: 'inherit' }} onClick={() => actions.viewTicket(issue.maintenance_ticket)}>
                        Ticket #{issue.maintenance_ticket.ticket_id}
                      </button>
                    ) : <>Ticket #{issue.maintenance_ticket.ticket_id}</>}
                    {' '}<TicketStatusBadge value={issue.maintenance_ticket.status} />
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="veh-card issue-view-desc">
            <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>Description &amp; Remarks</h4></div>
            <div className="issue-view-text">
              <p className="p23-prewrap">{issue.issue_description || '-'}</p>
              {issue.remarks && (
                <div className="issue-view-remarks">
                  <span className="issue-view-remarks-label"><Icon name="clipboard" size={12} /> Remarks</span>
                  <p className="p23-prewrap">{issue.remarks}</p>
                </div>
              )}
            </div>
          </section>

          {issue.vehicle && (
            <section className="veh-card issue-view-map">
              <div className="veh-card-head"><Icon name="pin" size={16} /><h4>Vehicle Location — {issue.vehicle.current_location ?? 'Unknown'}</h4></div>
              <div className="issue-view-map-wrap">
                <VehicleLocationMap lat={hub?.lat} lng={hub?.lng} label={issue.vehicle.current_location} />
              </div>
            </section>
          )}
        </div>

        <div className="issue-view-side">
          <IssueFilesCard issue={issue} />

          <section className="veh-card">
            <div className="veh-card-head"><Icon name="calendar" size={16} /><h4>Report Timeline</h4></div>
            <div className="issue-view-timeline">
              <div className="issue-view-timeline-row">
                <span className="issue-view-timeline-dot" />
                <div>
                  <p className="issue-view-timeline-label">Reported</p>
                  <QuietDate value={issue.created_at} />
                </div>
              </div>
              {issue.maintenance_ticket && (
                <div className="issue-view-timeline-row">
                  <span className="issue-view-timeline-dot" />
                  <div>
                    <p className="issue-view-timeline-label">Ticket #{issue.maintenance_ticket.ticket_id} — {issue.maintenance_ticket.status}</p>
                    {issue.maintenance_ticket.created_at && <QuietDate value={issue.maintenance_ticket.created_at} />}
                  </div>
                </div>
              )}
              {issue.updated_at && issue.updated_at !== issue.created_at && (
                <div className="issue-view-timeline-row">
                  <span className="issue-view-timeline-dot is-last" />
                  <div>
                    <p className="issue-view-timeline-label">{issue.status === 'Resolved' ? 'Resolved' : 'Last Updated'}</p>
                    <QuietDate value={issue.updated_at} />
                  </div>
                </div>
              )}
            </div>
          </section>

          {historyTotal > 0 && (
            <section className="veh-card">
              <div className="veh-card-head"><Icon name="grid" size={16} /><h4>Issue History</h4></div>
              <p className="solid-pie-subtitle">{issue.vehicle?.vehicle_name ?? 'This vehicle'} — {historyTotal} report{historyTotal === 1 ? '' : 's'} total</p>
              <SolidPieLegend segments={historySegments} total={historyTotal} />
              <SolidPieChart segments={historySegments} />
            </section>
          )}
        </div>
      </div>
    </ModulePanel>
  );
}

// Quick-glance companion to the stat row — a scrollable activity timeline of
// the newest reports (vehicle, issue, reporter), so "what's come in
// recently" doesn't require scrolling the full table below. Sourced from the
// unfiltered list, so a search/filter on the main table doesn't empty it out.
export function LatestIssueCard({ issues = [], onRowClick }) {
  const sorted = useMemo(
    () => [...issues].sort((a, b) => (b.issue_report_id ?? 0) - (a.issue_report_id ?? 0)),
    [issues]
  );

  return (
    <aside className="panel latest-issue-card latest-issue-timeline">
      <div className="latest-issue-card-head">
        <span className="latest-issue-card-label">Latest Reports</span>
        <span className="count-badge">{issues.length}</span>
      </div>
      <div className="latest-issue-timeline-list">
        {sorted.length === 0 ? (
          <p className="muted">No issues reported yet.</p>
        ) : (
          sorted.map((row) => (
            <button
              key={row.issue_report_id}
              type="button"
              className="latest-issue-timeline-item"
              onClick={() => onRowClick?.(row)}
            >
              <span className="latest-issue-timeline-dot" />
              <span className="latest-issue-timeline-icon"><Icon name="mail" size={16} /></span>
              <span className="latest-issue-timeline-body">
                <strong>{row.vehicle?.vehicle_name ?? 'Unknown vehicle'}</strong>
                <span className="muted">
                  {row.issue_type ?? 'Unspecified issue'} reported by {row.reported_by?.name ?? 'Unknown reporter'}.
                </span>
              </span>
              <span className="latest-issue-timeline-time">{timeAgo(row.created_at)}</span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

// File cabinet on a vehicle's profile page — deliberately separate from the
// vehicle's own cover photo (shown in Vehicle Information above), so this
// list is only ever what someone explicitly uploaded here: receipts,
// registration papers, insurance, etc. Fetches its own data so the parent
// profile page doesn't need to know about documents at all.
// Read-only "filing cabinet" for an issue report's files: photos as a
// thumbnail grid, everything else as typed rows. A legacy single photo_url
// (reports from before multi-file) is folded in as the first photo.
export function IssueFilesCard({ issue }) {
  const files = [
    ...(issue.photo_url ? [{ key: 'legacy', url: resolvePhotoUrl(issue.photo_url), name: 'Photo', isImage: true, at: issue.created_at, by: issue.reported_by?.name }] : []),
    ...(issue.attachments ?? []).map((att) => {
      const name = att.original_name ?? att.file_url?.split('/').pop() ?? 'Attachment';
      return {
        key: att.attachment_id,
        url: resolvePhotoUrl(att.file_url),
        name,
        ext: (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'file').toUpperCase(),
        isImage: /\.(png|jpe?g|gif|webp)$/i.test(name),
        at: att.created_at,
        by: att.uploaded_by?.name,
      };
    }),
  ];
  const photos = files.filter((f) => f.isImage);
  const docs = files.filter((f) => !f.isImage);

  return (
    <section className="veh-card veh-files issue-files">
      <div className="veh-card-head veh-files-head">
        <div className="veh-files-head-title"><Icon name="clipboard" size={16} /><h4>Files</h4></div>
        {files.length > 0 && <span className="count-badge">{files.length}</span>}
      </div>
      <div className="veh-files-body">
        {files.length === 0 ? (
          <div className="file-card-empty">No files attached</div>
        ) : (
          <>
            {photos.length > 0 && (
              <div className="issue-files-grid">
                {photos.map((f) => (
                  <a key={f.key} href={f.url} target="_blank" rel="noreferrer" className="issue-files-thumb" title={f.name}>
                    <img src={f.url} alt={f.name} />
                  </a>
                ))}
              </div>
            )}
            {docs.length > 0 && (
              <div className="issue-files-list">
                {docs.map((f) => (
                  <a key={f.key} href={f.url} target="_blank" rel="noreferrer" className="issue-files-row">
                    <span className={`issue-files-ext is-${f.ext.toLowerCase()}`}>{f.ext}</span>
                    <span className="issue-files-meta">
                      <strong>{f.name}</strong>
                      <span>{[f.by, f.at && formatDate(f.at)].filter(Boolean).join(' · ')}</span>
                    </span>
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

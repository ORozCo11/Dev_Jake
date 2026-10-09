import { useLocation } from 'react-router-dom';
import Icon from '../../components/Icon';
import api from '../../api/axios';
import Modal from '../components/Modal';
import { ModulePanel, StatusBadge, UserAvatarName } from '../components/ui';
import { SmartForm } from '../forms/SmartForm';
import { cleanPayload, sendPayload, showError } from '../lib/data';
import { passwordFields, profileFields } from '../lib/fields';
import { formatDate, resolvePhotoUrl } from '../lib/format';
import { canDo } from '../lib/permissions';
import { accountStatus, splitRoles } from '../lib/userAccounts';

export function UserInfoModal({ user, onClose }) {
  const initials = user.name
    ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U';

  return (
    <Modal title="Reporter Information" onClose={onClose}>
      <div className="user-info-card">
        <div className="profile-avatar user-info-avatar" aria-hidden="true">{initials}</div>
        <div>
          <p className="user-info-name">{user.name}</p>
          {user.role && <span className="user-info-role">{user.role}</span>}
        </div>
      </div>
      <dl className="user-info-details">
        {user.email && (
          <div>
            <dt>Email</dt>
            <dd>{user.email}</dd>
          </div>
        )}
        {user.id != null && (
          <div>
            <dt>User ID</dt>
            <dd>#{user.id}</dd>
          </div>
        )}
      </dl>
    </Modal>
  );
}

// Full-page user profile — clicking a user anywhere (any table, any role) opens
// this instead of a popup. Uses the loaded users list when available, otherwise
// the user object carried on navigation state (so non-admins can view it too).
export function UserViewPage({ userId, users = [], currentUser, onEdit }) {
  const location = useLocation();
  const user = (users ?? []).find((u) => String(u.id) === String(userId)) || location.state?.user || null;

  if (!user) {
    return (
      <ModulePanel description="This user account could not be found.">
      </ModulePanel>
    );
  }

  const initials = user.name ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() : 'U';
  const status = accountStatus(user);
  const { primary, additional } = splitRoles(user);

  return (
    <ModulePanel description="User account profile and contact details.">
      <div className="vehicle-profile-header">
        <div className="vehicle-profile-identity">
          <span className="ticket-detail-id">User ID #{user.id}</span>
          <h3 className="ticket-detail-title">{user.name}</h3>
          <div className="p23-account-strip">
            <StatusBadge value={status.label} />
            <span>{status.detail}</span>
          </div>
        </div>
        {canDo(currentUser, 'user.edit') && (
          <button className="primary-button" type="button" onClick={onEdit}><Icon name="edit" size={14} /> Edit User</button>
        )}
      </div>

      <div className="user-view-dash">
        <section className="veh-card">
          <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>User Information</h4></div>
          <div className="user-view-body">
            <div className="user-view-avatar">
              {user.photo_url ? <img src={resolvePhotoUrl(user.photo_url)} alt={user.name} /> : <span>{initials}</span>}
            </div>
            <dl className="veh-kv">
              <div><dt>Full Name</dt><dd>{user.name}</dd></div>
              <div><dt>Primary Role</dt><dd>{primary ? <StatusBadge value={primary} /> : '-'}</dd></div>
              <div><dt>Additional Roles</dt><dd>{additional.length ? <span className="p23-role-list">{additional.map((r) => <StatusBadge key={r} value={r} />)}</span> : 'None'}</dd></div>
              <div><dt>Account Status</dt><dd><StatusBadge value={status.label} /></dd></div>
              <div><dt>{status.key === 'pending' ? 'Registered' : 'Approved'}</dt><dd>{status.key === 'pending' ? formatDate(user.created_at) : (user.approved_at ? formatDate(user.approved_at) : 'Created by an Admin')}</dd></div>
            </dl>
          </div>
        </section>

        <section className="veh-card">
          <div className="veh-card-head"><Icon name="key" size={16} /><h4>Contact &amp; Login</h4></div>
          <dl className="veh-kv">
            <div><dt>Email</dt><dd>{user.email ?? '-'}</dd></div>
            <div><dt>Phone</dt><dd>{user.phone || '-'}</dd></div>
            <div><dt>Address</dt><dd>{user.address || '-'}</dd></div>
          </dl>
        </section>
      </div>
    </ModulePanel>
  );
}

export function ProfileMenu({ user, open, setOpen, onLogout, onOpenNotifications, onOpenSettings }) {
  const initials = user.name
    ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U';
  // Show the uploaded profile photo when there is one; fall back to initials.
  const avatarInner = user.photo_url
    ? <img className="profile-menu-avatar-img" src={resolvePhotoUrl(user.photo_url)} alt={user.name} />
    : initials;

  return (
    <>
      <button className="profile-menu-trigger" type="button" onClick={() => setOpen((v) => !v)} aria-label="Account menu">
        <span className="profile-menu-avatar">{avatarInner}</span>
      </button>

      {open && (
        <div className="profile-menu-dropdown">
          <div className="profile-menu-user">
            <span className="profile-menu-avatar">{avatarInner}</span>
            <div className="profile-menu-user-info">
              <span className="profile-menu-name">{user.name}</span>
              <span className="profile-menu-role">{user.role}</span>
            </div>
          </div>

          <div className="profile-menu-divider" />

          <button className="profile-menu-item" type="button" onClick={() => { onOpenSettings(); setOpen(false); }}>
            <Icon name="key" size={15} /> My Settings
          </button>
          <button className="profile-menu-item" type="button" onClick={() => { onOpenNotifications(); setOpen(false); }}>
            <Icon name="bell" size={15} /> Notifications
          </button>

          <div className="profile-menu-divider" />

          <button className="profile-menu-item profile-menu-item-danger" type="button" onClick={onLogout}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
            Logout
          </button>
        </div>
      )}
    </>
  );
}

/** Self-service profile page (all roles) — editable details (same fields/layout
 * an Admin uses on Update User) plus a separate password-change section, since
 * that one stays gated behind old-password verification. */
export function ProfilePage({ user, onBack, setNotice, refreshUser, onDirty }) {
  const initials = user.name ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() : 'U';
  const roles = (Array.isArray(user.roles) && user.roles.length) ? user.roles : [user.role].filter(Boolean);

  const updateDetails = async (payload) => {
    setNotice(null);
    try {
      await sendPayload('put', '/profile', payload);
      await refreshUser();
      setNotice({ type: 'success', text: 'Profile updated.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const updatePassword = async (payload) => {
    setNotice(null);
    try {
      await api.put('/profile/password', cleanPayload(payload));
      setNotice({ type: 'success', text: 'Password updated.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };

  return (
    <ModulePanel description="Your account details and password.">
      <div className="vehicle-profile-header">
        <div className="vehicle-profile-identity">
          <span className="ticket-detail-id">My Profile</span>
          <h3 className="ticket-detail-title">{user.name}</h3>
        </div>
      </div>

      <div className="profile-page">
        <div className="profile-hero">
          <div className="profile-hero-avatar">
            {user.photo_url
              ? <img src={resolvePhotoUrl(user.photo_url)} alt={user.name} />
              : <span>{initials}</span>}
          </div>
          <div className="profile-hero-info">
            <h2>{user.name}</h2>
            <p className="muted">{user.email}</p>
            <div className="profile-hero-roles">{roles.map((r) => <StatusBadge key={r} value={r} />)}</div>
          </div>
        </div>

        <div className="profile-section">
          <h4 className="profile-section-title"><Icon name="edit" size={15} /> Edit Details</h4>
          <p className="muted profile-section-hint">Keep your contact information up to date.</p>
          <div className="form-grid-2col user-form-grid">
            <SmartForm
              fields={profileFields(user.photo_url)}
              initialValues={user}
              key="profile-details"
              onCancel={onBack}
              onSubmit={updateDetails}
              onValuesChange={() => onDirty?.()}
              submitLabel="Save Changes"
              title=""
            />
          </div>
        </div>

        <div className="profile-section">
          <h4 className="profile-section-title"><Icon name="key" size={15} /> Change Password</h4>
          <p className="muted profile-section-hint">Use a strong password you don't reuse on other sites.</p>
          <div className="profile-form">
            <SmartForm
              fields={passwordFields}
              key="profile-password"
              onCancel={onBack}
              onSubmit={updatePassword}
              onValuesChange={() => onDirty?.()}
              submitLabel="Update Password"
              title=""
            />
          </div>
        </div>
      </div>
    </ModulePanel>
  );
}

// Card-view counterpart to the Users table row — avatar, name, role(s), and
// contact details on a single clickable tile, mirroring TicketCard/
// MaintenanceRecordCard's click-to-edit convention for this module's card view.
export function UserCard({ user: person, onClick }) {
  const initials = (person.name || '?').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
  const { primary, additional } = splitRoles(person);
  const status = accountStatus(person);

  return (
    <div className="user-card" onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <div className="user-card-avatar">
        {person.photo_url ? <img src={resolvePhotoUrl(person.photo_url)} alt={person.name} /> : <span>{initials}</span>}
      </div>
      <strong className="user-card-name">{person.name}</strong>
      <span className="user-card-role">{primary ?? '—'}{additional.length ? <span className="p23-role-extra"> + {additional.join(', ')}</span> : null}</span>
      <span className="user-card-underline" />
      <div className="user-card-contact">
        <span>{person.phone || 'No phone on file'}</span>
        <a href={`mailto:${person.email}`} onClick={(e) => e.stopPropagation()}>{person.email}</a>
      </div>
      <StatusBadge value={status.label} />
      <span className="p23-card-status-detail">{status.detail}</span>
    </div>
  );
}

// Users-page status/role quick filters as toggle chips (aria-pressed), driving
// the same filterActive / filterStatus state the dropdowns used.
export function UserFilterChips({ statusOptions, selectedStatus, onStatusChange, roleOptions, selectedRoles, onRolesChange, counts = {} }) {
  const toggle = (list, value, set) => set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const anyActive = selectedStatus.length > 0 || selectedRoles.length > 0;
  return (
    <div className="p23-chip-bar">
      <div className="p23-chip-group" role="group" aria-label="Filter by account status">
        <span className="p23-chip-label">Status</span>
        {statusOptions.map((value) => (
          <button key={value} type="button" className="p23-chip" aria-pressed={selectedStatus.includes(value)} onClick={() => toggle(selectedStatus, value, onStatusChange)}>
            {value}{counts[value] != null ? <span className="p23-chip-count">{counts[value]}</span> : null}
          </button>
        ))}
      </div>
      <div className="p23-chip-group" role="group" aria-label="Filter by role">
        <span className="p23-chip-label">Role</span>
        {roleOptions.map((value) => (
          <button key={value} type="button" className="p23-chip" aria-pressed={selectedRoles.includes(value)} onClick={() => toggle(selectedRoles, value, onRolesChange)}>
            {value}{counts[value] != null ? <span className="p23-chip-count">{counts[value]}</span> : null}
          </button>
        ))}
      </div>
      {anyActive && (
        <button type="button" className="ghost-button p23-chip-clear" onClick={() => { onStatusChange([]); onRolesChange([]); }}>
          Clear filters
        </button>
      )}
    </div>
  );
}

// Self-registrations waiting for an Admin — kept apart from working accounts
// so approving someone is its own clear task, not a row hidden among the rest.
export function PendingRegistrations({ rows, onReview }) {
  if (!rows.length) {
    return (
      <div className="empty-state p23-empty">
        <p>No registrations are waiting for approval.</p>
        <p>New staff sign up with your barangay's Staff Registration Code; their requests appear here for you to review.</p>
      </div>
    );
  }
  return (
    <ul className="p23-pending-list">
      {rows.map((row) => (
        <li key={row.id} className="p23-pending-card">
          <div className="p23-pending-who">
            <UserAvatarName user={row} />
            <span className="p23-pending-email">{row.email}</span>
          </div>
          <dl className="p23-pending-meta">
            <div><dt>Requested role</dt><dd>{row.role ? <StatusBadge value={row.role} /> : '—'}</dd></div>
            <div><dt>Registered</dt><dd>{formatDate(row.created_at)}</dd></div>
            {row.phone && <div><dt>Phone</dt><dd>{row.phone}</dd></div>}
          </dl>
          <button type="button" className="primary-button" onClick={() => onReview(row)} aria-label={`Review and approve ${row.name}`}>
            Review &amp; approve
          </button>
        </li>
      ))}
    </ul>
  );
}

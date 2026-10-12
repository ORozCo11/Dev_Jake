import { useCallback, useEffect, useRef, useState } from 'react';
import { geocodeAddress, reverseGeocode } from '../../utils/geocode';
import { isPointWithinBoundaryRings } from '../../utils/boundary';
import Icon from '../../components/Icon';
import { AddLocationMap } from '../../components/lazy';
import { ModulePanel } from '../components/ui';

// Its own page (not a modal/inline panel) reached at .../locations/new —
// typing a Complete Address geocodes it and drops/moves the map pin there;
// clicking the map instead reverse-geocodes the click back into the Address
// field. Either path has to land inside the active service-area boundary
// (the same polygon the fleet map draws) before Save is allowed — an
// out-of-bounds result shows why instead of silently creating a hub nobody
// can find on the map. Saving POSTs to /hubs, same endpoint and shape the
// map's own "Add Hub" flow uses.
// Shared by NewLocationPage ("Add Location", defines a brand-new hub) and
// EditLocationPage ("Update Location", reassigns a vehicle — to an existing
// hub OR, same as Add, a brand-new one typed/clicked in) — both need the
// exact same address<->map sync and boundary check; only the extra
// Address/Area + Remarks fields and the submit wiring differ by mode.
export function LocationAddressMapForm({
  mode = 'add',
  initialName = '',
  initialAddress = '',
  initialMarker = null,
  initialAddressArea = '',
  initialRemarks = '',
  boundaryRings,
  boundaryLabel,
  onBack,
  onSubmit,
}) {
  const isEdit = mode === 'edit';
  const [name, setName] = useState(initialName);
  const [address, setAddress] = useState(initialAddress);
  const [marker, setMarker] = useState(initialMarker);
  const [addressArea, setAddressArea] = useState(initialAddressArea);
  const [remarks, setRemarks] = useState(initialRemarks);
  const [error, setError] = useState(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Distinguishes "the map just moved the pin, don't re-geocode the address
  // that produced it" from "the admin is typing" — without it, a map click
  // (which fills Address via reverse geocoding) would immediately trigger
  // the address-typing effect below and re-geocode right back, wasting a
  // lookup and risking a slightly different point than the one clicked.
  const addressFromMapRef = useRef(false);
  // Edit mode starts with `address` already non-empty (the hub's own
  // internal name/address, paired with a marker we already know is correct
  // from initialMarker) — without this, mounting immediately re-triggers
  // the geocode effect below on that pre-filled value, which usually isn't
  // a real searchable address string, showing a spurious "couldn't find
  // that address" error over a perfectly valid pin. Compared by VALUE
  // (not a one-shot consumed flag) so React StrictMode's dev-only double
  // effect invocation — same address, effect body run twice — still skips
  // both times instead of geocoding on the second pass.
  const skipGeocodeForAddressRef = useRef(initialAddress || null);

  // Debounced geocode-as-you-type — waits for a pause in typing so it's not
  // firing a lookup on every keystroke.
  useEffect(() => {
    if (addressFromMapRef.current) {
      addressFromMapRef.current = false;
      return undefined;
    }
    if (skipGeocodeForAddressRef.current !== null && address === skipGeocodeForAddressRef.current) {
      return undefined;
    }
    skipGeocodeForAddressRef.current = null;
    const trimmed = address.trim();
    if (!trimmed) return undefined;

    const timer = setTimeout(async () => {
      setLookingUp(true);
      setError(null);
      try {
        const match = await geocodeAddress(trimmed);
        if (!match) {
          setError(`Couldn't find that address yet — keep typing, or click the map instead.`);
          return;
        }
        setMarker({ lat: match.lat, lng: match.lng });
        if (!isPointWithinBoundaryRings(match, boundaryRings)) {
          setError(`That address is outside the ${boundaryLabel} boundary — only locations within ${boundaryLabel} can be added.`);
        }
      } catch (err) {
        setError(err.message || 'Address lookup failed.');
      } finally {
        setLookingUp(false);
      }
    }, 700);

    return () => clearTimeout(timer);
  }, [address, boundaryRings, boundaryLabel]);

  const handleMapPick = useCallback(async (latLng) => {
    setMarker(latLng);
    setError(null);

    if (!isPointWithinBoundaryRings(latLng, boundaryRings)) {
      setError(`That spot is outside the ${boundaryLabel} boundary — only locations within ${boundaryLabel} can be added.`);
      return;
    }

    setLookingUp(true);
    try {
      const displayName = await reverseGeocode(latLng.lat, latLng.lng);
      if (displayName) {
        addressFromMapRef.current = true;
        setAddress(displayName);
      }
    } catch {
      // Reverse geocoding is a convenience, not a requirement — a failed
      // lookup still leaves a valid, in-bounds pin; the admin can type the
      // address in by hand instead.
    } finally {
      setLookingUp(false);
    }
  }, [boundaryRings, boundaryLabel]);

  const isPinValid = marker && isPointWithinBoundaryRings(marker, boundaryRings);
  const canSubmit = name.trim() && isPinValid && !lookingUp && !submitting;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        lat: marker.lat,
        lng: marker.lng,
        label: name.trim().substring(0, 2).toUpperCase(),
        addressArea: addressArea.trim(),
        remarks: remarks.trim(),
      });
    } catch (err) {
      setError(err.response?.data?.message || err.message || `Failed to ${isEdit ? 'update' : 'add'} location.`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModulePanel description={
      isEdit
        ? 'Type the complete address or click the map — either one fills in the other. Pick where this vehicle already is, or move it to a brand-new location the same way you would add one.'
        : 'Type the complete address or click the map — either one fills in the other.'
    }>
      <form className="add-location-page" onSubmit={handleSubmit} noValidate>
        <div className="add-location-fields smart-form">
          {error && (
            <div className="toast-notice toast-notice-validation error" role="alert">
              <Icon name="alert" size={17} className="toast-notice-icon" />
              <div className="toast-notice-lines"><span>{error}</span></div>
            </div>
          )}
          <label className={name.trim() ? 'has-value' : undefined}>
            <span>Location Name <span className="required-asterisk">*</span></span>
            <input
              type="text"
              required
              placeholder="e.g. Paknaan Health Center"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {isEdit && <small className="field-hint">An existing name reuses that location; a new one creates it.</small>}
          </label>
          <label className={address.trim() ? 'has-value' : undefined}>
            <span>Complete Address <span className="required-asterisk">*</span></span>
            <input
              type="text"
              required
              placeholder="e.g. Purok 5, Paknaan, Mandaue City, Cebu"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <small className="field-hint">
              {lookingUp ? 'Looking up…' : `Must be within the ${boundaryLabel} boundary — you can also click the map to pinpoint it.`}
            </small>
          </label>
          {isEdit && (
            <>
              <label className={addressArea.trim() ? 'has-value' : undefined}>
                <span>Address / Area</span>
                <input
                  type="text"
                  placeholder="e.g. Bay 3, near the north gate"
                  value={addressArea}
                  onChange={(e) => setAddressArea(e.target.value)}
                />
              </label>
              <label className={remarks.trim() ? 'has-value' : undefined}>
                <span>Remarks</span>
                <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
              </label>
            </>
          )}
          <div className="form-actions">
            <button className="ghost-button" onClick={onBack} type="button" disabled={submitting}>Cancel</button>
            <button className="primary-button" type="submit" disabled={!canSubmit}>
              {submitting ? 'Saving…' : (isEdit ? 'Update Location' : 'Add Location')}
            </button>
          </div>
        </div>
        <div className="add-location-map-shell">
          <AddLocationMap marker={marker} boundaryRings={boundaryRings} onPick={handleMapPick} />
        </div>
      </form>
    </ModulePanel>
  );
}

export function NewLocationPage({ onBack, boundaryRings, boundaryLabel, onSubmit }) {
  return (
    <LocationAddressMapForm
      mode="add"
      boundaryRings={boundaryRings}
      boundaryLabel={boundaryLabel}
      onBack={onBack}
      onSubmit={({ name, lat, lng, label }) => onSubmit({ name, lat, lng, label })}
    />
  );
}

// Its own page (.../locations/:vehicleId/edit), reached from the pencil icon
// on the Location Records table — reassigns a vehicle's current location.
// Reuses the exact same address/map picker Add Location uses (not just a
// dropdown of existing hubs) so moving a vehicle to a genuinely new spot
// doesn't require a separate trip to Add Location first; the parent's
// onSubmit decides whether the typed name matches an existing hub (reuse
// it) or not (create it), same as Add Location's own POST /hubs.
export function EditLocationPage({ row, allHubs, boundaryRings, boundaryLabel, onBack, onSubmit }) {
  if (!row) {
    return (
      <ModulePanel description="Update a vehicle's current location.">
        <p className="empty-state">
          That vehicle's location record couldn't be found — it may have been removed.{' '}
          <button type="button" className="link-button" onClick={onBack}>Back to Location Records</button>
        </p>
      </ModulePanel>
    );
  }

  const currentHub = allHubs.find((h) => h.name === row.current_location);

  return (
    <LocationAddressMapForm
      mode="edit"
      initialName={row.current_location ?? ''}
      initialAddress={currentHub?.address ?? row.current_location ?? ''}
      initialMarker={currentHub ? { lat: currentHub.lat, lng: currentHub.lng } : null}
      initialAddressArea={row.address_area ?? ''}
      initialRemarks={row.remarks ?? ''}
      boundaryRings={boundaryRings}
      boundaryLabel={boundaryLabel}
      onBack={onBack}
      onSubmit={onSubmit}
    />
  );
}

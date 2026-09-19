import { useContext, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import api from '../api/axios';
import Icon from '../components/Icon';
import Aurora from '../components/Aurora';
import AuthHeader from '../components/AuthHeader';
import AuthFooter from '../components/AuthFooter';
import { AuthContext } from '../context/AuthContextObject';

const roleRoutes = {
  Admin: '/admin',
  Custodian: '/custodian',
  'Maintenance Personnel': '/maintenance',
  'Super Admin': '/superadmin',
};

const emptyForm = {
  first_name: '',
  middle_name: '',
  last_name: '',
  email: '',
  phone: '',
  address: '',
  province_id: '',
  city_id: '',
  barangay_id: '',
  barangay_name: '',
  requested_role: '',
  staff_code: '',
  password: '',
  password_confirmation: '',
};

const NAME_CHARS = /[^A-Za-zÀ-ÖØ-öø-ÿ.'\- ]/g;
const NAME_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿ.'\- ]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^09\d{9}$/;

const STEP_LABELS = ['Personal Info', 'Location', 'Account'];

function Register() {
  const { token, user } = useContext(AuthContext);
  const [form, setForm] = useState(emptyForm);
  const [step, setStep] = useState(1);
  const [provinces, setProvinces] = useState([]);
  const [cities, setCities] = useState([]);
  const [barangays, setBarangays] = useState([]);
  const [barangaysLoading, setBarangaysLoading] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [isFirstForBarangay, setIsFirstForBarangay] = useState(null);

  useEffect(() => {
    api.get('/provinces')
      .then((response) => setProvinces(response.data))
      .catch(() => setProvinces([]));
  }, []);

  useEffect(() => {
    if (!form.province_id) return;
    api.get('/cities', { params: { province_id: form.province_id } })
      .then((response) => setCities(response.data))
      .catch(() => setCities([]));
  }, [form.province_id]);

  useEffect(() => {
    if (!form.city_id) return;
    // Tracked separately from an empty list: until this resolves we don't yet
    // know whether the city has a barangay list, and treating "still loading"
    // as "no list" flashes the free-text fallback into view.
    setBarangaysLoading(true);
    api.get('/barangays', { params: { city_id: form.city_id } })
      .then((response) => setBarangays(response.data))
      .catch(() => setBarangays([]))
      .finally(() => setBarangaysLoading(false));
  }, [form.city_id]);

  useEffect(() => {
    if (!form.city_id || (!form.barangay_id && !form.barangay_name.trim())) {
      setIsFirstForBarangay(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const params = { city_id: form.city_id };
      if (form.barangay_id) params.barangay_id = form.barangay_id;
      else params.barangay_name = form.barangay_name.trim();
      api.get('/registration-status', { params })
        .then((response) => { if (!cancelled) setIsFirstForBarangay(response.data.is_first); })
        .catch(() => { if (!cancelled) setIsFirstForBarangay(null); });
    }, form.barangay_id ? 0 : 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [form.city_id, form.barangay_id, form.barangay_name]);

  if (token && user) {
    return <Navigate to={roleRoutes[user.role] ?? '/unauthorized'} replace />;
  }

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  };

  const handleProvinceChange = (event) => {
    const { value } = event.target;
    setForm((current) => ({ ...current, province_id: value, city_id: '', barangay_id: '', barangay_name: '' }));
    setCities([]);
    setBarangays([]);
  };

  const handleCityChange = (event) => {
    const { value } = event.target;
    setForm((current) => ({ ...current, city_id: value, barangay_id: '', barangay_name: '' }));
    setBarangays([]);
  };

  const handleNameChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value.replace(NAME_CHARS, '') }));
  };

  const handlePhoneChange = (event) => {
    const digits = event.target.value.replace(/\D/g, '').slice(0, 11);
    setForm((current) => ({ ...current, phone: digits }));
  };

  const validateStep1 = () => {
    if (!NAME_PATTERN.test(form.first_name.trim())) { setError('First name may only contain letters.'); return false; }
    if (form.middle_name.trim() && !NAME_PATTERN.test(form.middle_name.trim())) { setError('Middle name may only contain letters.'); return false; }
    if (!NAME_PATTERN.test(form.last_name.trim())) { setError('Last name may only contain letters.'); return false; }
    if (!EMAIL_PATTERN.test(form.email.trim())) { setError('Please enter a valid email address.'); return false; }
    if (!PHONE_PATTERN.test(form.phone)) { setError('Phone number must be 11 digits starting with 09 (e.g. 09171234567).'); return false; }
    return true;
  };

  const validateStep2 = () => {
    if (!form.province_id) { setError('Please select your province.'); return false; }
    if (!form.city_id) { setError('Please select your city/municipality.'); return false; }
    if (!form.barangay_id && !form.barangay_name.trim()) { setError('Please enter or select your barangay.'); return false; }
    if (!form.address.trim()) { setError('Street address is required.'); return false; }
    return true;
  };

  const handleNext = () => {
    setError('');
    if (step === 1 && validateStep1()) setStep(2);
    else if (step === 2 && validateStep2()) setStep(3);
  };

  const handleBack = () => {
    setError('');
    setStep((s) => s - 1);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    setError('');

    if (!isFirstForBarangay && !form.requested_role) {
      setError('Please select whether you are a Custodian or Maintenance Personnel.');
      return;
    }
    if (!form.staff_code.trim()) {
      setError('Please enter the staff registration code given to you by your barangay office.');
      return;
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (form.password !== form.password_confirmation) {
      setError('Password and confirmation do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const name = [form.first_name, form.middle_name, form.last_name]
        .map((part) => part.trim())
        .filter(Boolean)
        .join(' ');
      await api.post('/register', { ...form, name });
      setSubmitted(true);
    } catch (requestError) {
      const messages = requestError.response?.data?.errors;
      if (isFirstForBarangay && messages && (messages.requested_role || messages.staff_code)) {
        setIsFirstForBarangay(false);
        setError('Someone else just registered as this barangay\'s first Administrator. Please select your role and enter the staff registration code below, then submit again.');
        const params = { city_id: form.city_id };
        if (form.barangay_id) params.barangay_id = form.barangay_id;
        else params.barangay_name = form.barangay_name.trim();
        api.get('/registration-status', { params })
          .then((response) => setIsFirstForBarangay(response.data.is_first))
          .catch(() => {});
      } else {
        const allMessages = messages ? Object.values(messages).map((arr) => arr[0]).filter(Boolean) : [];
        setError(
          allMessages.length ? allMessages.join(' ') :
            requestError.response?.data?.message ??
            'Unable to register. Please check your connection and try again.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page-shell slide-in">
      <AuthHeader />

      <main className="auth-split-page">
        <section className="auth-split-panel" aria-labelledby="register-title">
          <div className="auth-logo-header">
            <h1 id="register-title" className="auth-login-heading">Register</h1>
          </div>

          {submitted ? (
            <div>
              <p className="notice success">
                Registration submitted. An administrator must approve your account before you can sign in.
              </p>
              <Link className="primary-button auth-submit-btn" to="/login" style={{ display: 'flex', textDecoration: 'none' }}>
                Back to Login
              </Link>
            </div>
          ) : (
            <>
              {/* Step indicator */}
              <div className="register-wizard-steps">
                {STEP_LABELS.map((label, i) => (
                  <div key={label} className={`register-wizard-step${step === i + 1 ? ' is-active' : step > i + 1 ? ' is-done' : ''}`}>
                    <div className="register-wizard-dot">
                      {step > i + 1 ? <Icon name="checkCircle" size={14} /> : i + 1}
                    </div>
                    <span>{label}</span>
                  </div>
                ))}
              </div>

              {/* Step 1 — Personal Info */}
              {step === 1 && (
                <div className="auth-form auth-form-grid">
                  <label className="auth-field">
                    <span>First Name</span>
                    <div className="auth-input-wrapper auth-input-plain">
                      <input autoComplete="off" maxLength={60} name="first_name" onChange={handleNameChange} placeholder="First name" type="text" value={form.first_name} />
                    </div>
                  </label>

                  <label className="auth-field">
                    <span>Middle Name</span>
                    <div className="auth-input-wrapper auth-input-plain">
                      <input autoComplete="off" maxLength={60} name="middle_name" onChange={handleNameChange} placeholder="Optional" type="text" value={form.middle_name} />
                    </div>
                  </label>

                  <label className="auth-field auth-field-full">
                    <span>Last Name</span>
                    <div className="auth-input-wrapper auth-input-plain">
                      <input autoComplete="off" maxLength={60} name="last_name" onChange={handleNameChange} placeholder="Last name" type="text" value={form.last_name} />
                    </div>
                  </label>

                  <label className="auth-field auth-field-full">
                    <span>Email Address</span>
                    <div className="auth-input-wrapper auth-input-plain">
                      <input autoComplete="off" name="email" onChange={handleChange} placeholder="Email address" type="email" value={form.email} />
                    </div>
                  </label>

                  <label className="auth-field auth-field-full">
                    <span>Phone Number</span>
                    <div className="auth-input-wrapper auth-input-plain">
                      <input autoComplete="off" inputMode="numeric" maxLength={11} name="phone" onChange={handlePhoneChange} placeholder="09XXXXXXXXX" type="tel" value={form.phone} />
                    </div>
                  </label>

                  {error && <p className="notice error auth-field-full">{error}</p>}

                  <button className="primary-button auth-submit-btn auth-field-full" type="button" onClick={handleNext}>
                    Next <Icon name="chevronRight" size={16} />
                  </button>
                </div>
              )}

              {/* Step 2 — Location */}
              {step === 2 && (
                <div className="auth-form auth-form-grid">
                  <label className="auth-field">
                    <span>Province</span>
                    <div className="auth-input-wrapper auth-input-plain">
                      <select name="province_id" onChange={handleProvinceChange} value={form.province_id}>
                        <option value="" disabled>Select province</option>
                        {provinces.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                  </label>

                  <label className="auth-field">
                    <span>City / Municipality</span>
                    <div className="auth-input-wrapper auth-input-plain">
                      <select disabled={!form.province_id} name="city_id" onChange={handleCityChange} value={form.city_id}>
                        <option value="" disabled>{form.province_id ? 'Select city/municipality' : 'Select province first'}</option>
                        {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  </label>

                  <label className="auth-field auth-field-full">
                    <span>Barangay</span>
                    <div className="auth-input-wrapper auth-input-plain">
                      {barangays.length > 0 || barangaysLoading ? (
                        <select disabled={barangaysLoading || !form.city_id} name="barangay_id" onChange={handleChange} value={form.barangay_id}>
                          <option value="" disabled>
                            {!form.city_id ? 'Select city first' : barangaysLoading ? 'Loading barangays…' : 'Select barangay'}
                          </option>
                          {barangays.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      ) : (
                        <input autoComplete="off" disabled={!form.city_id} name="barangay_name" onChange={handleChange} placeholder={form.city_id ? 'Barangay name' : 'Select city first'} type="text" value={form.barangay_name} />
                      )}
                    </div>
                    {form.city_id && !barangaysLoading && barangays.length === 0 && (
                      <p className="notice warning">
                        No barangay list for this city yet — type the name and we&apos;ll add it.
                      </p>
                    )}
                  </label>

                  {isFirstForBarangay === true && (
                    <p className="notice success auth-field-full">
                      You&apos;ll be the first to register here — you&apos;ll become this barangay&apos;s Administrator once your staff code is verified.
                    </p>
                  )}

                  <label className="auth-field auth-field-full">
                    <span>Street Address</span>
                    <div className="auth-input-wrapper auth-input-plain">
                      <input autoComplete="off" name="address" onChange={handleChange} placeholder="House no. / street / purok" type="text" value={form.address} />
                    </div>
                  </label>

                  {error && <p className="notice error auth-field-full">{error}</p>}

                  <div className="auth-field-full register-wizard-nav">
                    <button className="ghost-button" type="button" onClick={handleBack}>
                      <Icon name="chevronLeft" size={16} /> Back
                    </button>
                    <button className="primary-button" type="button" onClick={handleNext}>
                      Next <Icon name="chevronRight" size={16} />
                    </button>
                  </div>
                </div>
              )}

              {/* Step 3 — Account Details */}
              {step === 3 && (
                <form className="auth-form auth-form-grid" autoComplete="off" onSubmit={handleSubmit} noValidate>
                  {isFirstForBarangay !== true && (
                    <label className="auth-field auth-field-full">
                      <span>I am a...</span>
                      <div className="auth-input-wrapper auth-input-plain">
                        <select name="requested_role" onChange={handleChange} value={form.requested_role}>
                          <option value="" disabled>Select your role</option>
                          <option value="Custodian">Custodian</option>
                          <option value="Maintenance Personnel">Maintenance Personnel</option>
                        </select>
                      </div>
                    </label>
                  )}

                  <label className="auth-field auth-field-full">
                    <span>Staff Registration Code</span>
                    <div className="auth-input-wrapper auth-input-plain">
                      <input autoComplete="off" name="staff_code" onChange={handleChange} placeholder="Given to you by your barangay office" type="text" value={form.staff_code} />
                    </div>
                  </label>

                  <label className="auth-field">
                    <span>Password</span>
                    <div className="auth-input-wrapper auth-input-plain">
                      <input autoComplete="new-password" name="password" onChange={handleChange} placeholder="Password" type={showPassword ? 'text' : 'password'} value={form.password} />
                      <button type="button" className="password-toggle-btn" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                        <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
                      </button>
                    </div>
                  </label>

                  <label className="auth-field">
                    <span>Confirm Password</span>
                    <div className="auth-input-wrapper auth-input-plain">
                      <input autoComplete="new-password" name="password_confirmation" onChange={handleChange} placeholder="Confirm password" type={showPassword ? 'text' : 'password'} value={form.password_confirmation} />
                    </div>
                  </label>

                  {error && <p className="notice error auth-field-full">{error}</p>}

                  <div className="auth-field-full register-wizard-nav">
                    <button className="ghost-button" type="button" onClick={handleBack} disabled={submitting}>
                      <Icon name="chevronLeft" size={16} /> Back
                    </button>
                    <button className="primary-button" disabled={submitting} type="submit">
                      {submitting ? (
                        <span className="btn-loading"><span className="btn-spinner" aria-hidden="true" />Submitting…</span>
                      ) : 'Create account'}
                    </button>
                  </div>
                </form>
              )}
            </>
          )}

          <p className="auth-legal">
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        </section>

        <div className="auth-split-hero">
          <Aurora colorStops={['#0b1220', '#1e3a5f', '#0f172a']} amplitude={0.6} blend={0.55} />
          <div className="auth-split-hero-content">
            <h2>Join Your Barangay's Fleet Team</h2>
            <p>
              Create an account to help track vehicle readiness, report
              issues, and coordinate maintenance for your barangay's fleet.
            </p>
          </div>
        </div>
      </main>

      <AuthFooter />
    </div>
  );
}

export default Register;

import { useState, useEffect } from 'react';
import api from '../api/axios';
import { AuthContext } from './AuthContextObject';

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  // "Remember me" decides WHERE the token lives: localStorage survives a
  // closed browser, sessionStorage clears the moment the tab/window closes.
  // Read both on boot since either could hold the active session.
  const [token, setToken] = useState(localStorage.getItem('token') || sessionStorage.getItem('token') || null);
  const [loading, setLoading] = useState(true);
  // True when the session couldn't be verified because the server was
  // unreachable (not because it was rejected) — the token is kept.
  const [sessionError, setSessionError] = useState(false);
  const [sessionCheck, setSessionCheck] = useState(0);

  const logout = () => {
    // Clear local state immediately so the UI reacts right away,
    // then invalidate the server-side token in the background.
    localStorage.removeItem('token');
    sessionStorage.removeItem('token');
    setToken(null);
    setUser(null);
    api.post('/logout').catch(() => {});
  };

  useEffect(() => {
    let cancelled = false;
    let retryTimer;
    // Only an explicit "this session is no longer valid" (401 / 419) ends the
    // session. A network blip, timeout or 5xx on a weak connection must not
    // log a field user out — keep the token and retry instead.
    const checkUserSession = async (attempt = 0) => {
      if (!token) { setLoading(false); return; }
      try {
        const response = await api.get('/user');
        if (cancelled) return;
        setUser(response.data);
        setSessionError(false);
        setLoading(false);
      } catch (error) {
        if (cancelled) return;
        const status = error?.response?.status;
        if (status === 401 || status === 419) {
          logout();
          setLoading(false);
        } else if (attempt < 4) {
          retryTimer = setTimeout(() => checkUserSession(attempt + 1), 1000 * 2 ** attempt);
        } else {
          setSessionError(true);
          setLoading(false);
        }
      }
    };
    checkUserSession();
    return () => { cancelled = true; clearTimeout(retryTimer); };
  }, [token, sessionCheck]);

  const retrySession = () => {
    setSessionError(false);
    setLoading(true);
    setSessionCheck((n) => n + 1);
  };

  const login = (userData, userToken, remember = true) => {
    // Only one storage ever holds the token at a time — clear the other so a
    // stale copy can't linger and outlive the choice the user just made.
    if (remember) {
      localStorage.setItem('token', userToken);
      sessionStorage.removeItem('token');
    } else {
      sessionStorage.setItem('token', userToken);
      localStorage.removeItem('token');
    }
    setToken(userToken);
    setUser(userData);
  };

  // Re-pull the logged-in user from the API (e.g. after they edit their own
  // profile) so the topbar name/avatar reflect the change without a reload.
  const refreshUser = async () => {
    try {
      const response = await api.get('/user');
      setUser(response.data);
    } catch {
      // keep the current user if the refresh fails
    }
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, loading, refreshUser, sessionError, retrySession }}>
      {children}
    </AuthContext.Provider>
  );
};

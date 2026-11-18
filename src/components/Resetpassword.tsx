import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import "./Auth.css";
import logo from "../assets/LOGO.jpeg";

/**
 * Reset password — where the emailed link lands.
 *
 * Two kinds of link work:
 *   • our own email template: /reset-password?token_hash=…&type=recovery.
 *     The link points at our own domain (so mail filters don't see a reset
 *     email linking to someone else's site); we confirm it here.
 *   • Supabase's default link, which signs the user in on the way here.
 */
export default function ResetPassword() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [linkError, setLinkError] = useState(false);
  const verifying = useRef(false);

  useEffect(() => {
    // When the user arrives from Supabase's own link, it fires a
    // PASSWORD_RECOVERY event and establishes a temporary session.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") setReady(true);
    });

    const params = new URLSearchParams(window.location.search);
    const tokenHash = params.get("token_hash");
    if (tokenHash && !verifying.current) {
      // Our own link: confirm it once (React may run this twice in development).
      verifying.current = true;
      void supabase.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" }).then(async ({ error: err }) => {
        // don't leave the one-time code in the address bar or history
        window.history.replaceState(null, "", window.location.pathname);
        if (!err) { setReady(true); return; }
        const { data } = await supabase.auth.getSession();
        if (data.session) setReady(true); else setLinkError(true);
      });
    } else if (!tokenHash) {
      // Also check if a session already exists (link already processed)
      supabase.auth.getSession().then(({ data }) => {
        if (data.session) setReady(true);
      });
    }
    return () => sub.subscription.unsubscribe();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 6) return setError("Use at least 6 characters.");
    if (password !== confirm) return setError("Passwords don't match.");

    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) { setError(err.message); return; }
    setDone(true);
    setTimeout(() => navigate("/login"), 2500);
  };

  return (
    <div className="auth-page">
      <form className="auth-card auth-card--narrow" onSubmit={submit}>
        <img src={logo} alt="Diocesan Youth Organization" className="auth-logo" />
        <h1>Set a new password</h1>

        {done ? (
          <p className="auth-note">Password updated. Taking you to sign in…</p>
        ) : linkError ? (
          <p className="auth-note">
            This reset link has expired or has already been used. Go back to{" "}
            <a href="/login">sign in</a> and tap "Forgot your password?" to get a new one.
          </p>
        ) : !ready ? (
          <p className="auth-note">
            Open this page from the reset link in your email. If you came from the
            email and still see this, the link may have expired — request a new one.
          </p>
        ) : (
          <>
            <input type="password" placeholder="New password" value={password}
                   autoComplete="new-password"
                   onChange={(e) => setPassword(e.target.value)} required disabled={busy} />
            <input type="password" placeholder="Confirm new password" value={confirm}
                   autoComplete="new-password"
                   onChange={(e) => setConfirm(e.target.value)} required disabled={busy} />
            {error && <p className="auth-error">{error}</p>}
            <button type="submit" disabled={busy}>{busy ? "Saving…" : "Update password"}</button>
          </>
        )}
      </form>
    </div>
  );
}
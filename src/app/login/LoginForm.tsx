"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

function LoginFormInner() {
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        const next = params.get("next") || "/";
        window.location.href = next.startsWith("/") ? next : "/";
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Sign in failed. Please try again.");
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit} noValidate>
        <div className="login-brand">
          <span className="cake-world-logo-mark">CW</span>
          <div>
            <strong>Cake World</strong>
            <small>Staff Dashboard</small>
          </div>
        </div>
        <h1>Sign in</h1>
        <p className="login-sub">Enter your administrator credentials to continue.</p>

        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}

        <label htmlFor="login-username">Username</label>
        <input
          id="login-username"
          name="username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoFocus
        />

        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        <button type="submit" className="login-submit" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

export default function LoginForm() {
  return (
    <Suspense fallback={<div className="login-page" />}>
      <LoginFormInner />
    </Suspense>
  );
}

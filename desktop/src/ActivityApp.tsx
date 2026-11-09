import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

type Snapshot = {
  serverUrl: string; deviceId: string; phase: string; message: string;
  userId: string | null; workerName: string | null; shiftId: string | null;
  pendingCount: number; heldCount: number;
  lastInputMs: number | null; lastSyncMs: number | null;
};
type PairCode = { code: string; expiresAt: number };
const titles: Record<string, string> = {
  unpaired: "Connect your shift", checking: "Checking your shift",
  active: "Active", idle: "Idle", break: "On break",
  offline: "Recording locally", attention: "Needs attention",
};
const descriptions: Record<string, string> = {
  unpaired: "Pair this computer to your open MoonBridge shift.",
  checking: "Confirming the current pairing and timecard status.",
  active: "Keyboard or mouse input was detected within the idle threshold.",
  idle: "No keyboard or mouse input for at least five minutes.",
  break: "Activity collection is paused while your timecard break is open.",
  offline: "MoonBridge is unavailable. Intervals are queued on this computer.",
  attention: "Check the message below before continuing.",
};

export default function ActivityApp() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [server, setServer] = useState("");
  const [code, setCode] = useState<PairCode | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editServer, setEditServer] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const refresh = useCallback(async () => {
    const next = await invoke<Snapshot>("get_snapshot");
    setState(next);
    return next;
  }, []);
  useEffect(() => {
    refresh().then((next) => setServer(next.serverUrl)).catch((e) => setError(String(e)));
    const timer = window.setInterval(() => void refresh().catch((e) => setError(String(e))), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      const left = Math.max(0, Math.ceil((code.expiresAt - Date.now()) / 1000));
      setRemaining(left);
      if (!left) {
        setCode(null);
        setError("Pairing code expired. Generate a new code.");
        return;
      }
      try {
        const done = await invoke<boolean>("complete_pairing", { code: code.code });
        if (cancelled) return;
        if (done) {
          setCode(null); setError(""); await refresh(); return;
        }
      } catch (e) { if (!cancelled) setError(String(e)); }
      if (!cancelled) timer = window.setTimeout(poll, 2500);
    };
    timer = window.setTimeout(poll, 1000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [code, refresh]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const paired = !!state?.shiftId;
  const gap = state?.lastInputMs == null ? "—" :
    state.lastInputMs < 60_000 ? `${Math.floor(state.lastInputMs / 1000)} sec` :
      `${Math.floor(state.lastInputMs / 60_000)} min ${Math.floor(state.lastInputMs % 60_000 / 1000)} sec`;
  if (!state) return <main className="loading">Opening MoonBridge Activity…</main>;
  return <main className="app-shell">
    <header className="brandbar"><div className="brand">
      <img src="/moonbridge-logo.png" alt="" /><span>MOONBRIDGE</span>
    </div><span>Activity</span></header>
    <div className="content">
      <div className="status-line"><span className={`status-dot status-${state.phase}`} />
        {paired ? "Current shift" : "Waiting for pairing"}
        <span className="device">This PC · {state.deviceId.slice(0, 11)}</span>
      </div>
      <h1>{code ? "Approve this computer" : titles[state.phase] || "Needs attention"}</h1>
      <p className="intro">{code
        ? "Sign in to MoonBridge, clock in, and enter this code in the desktop pairing section."
        : descriptions[state.phase] || descriptions.attention}</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      {state.message && <div className="notice" role="status">{state.message}</div>}
      {!paired && !code && (!state.serverUrl || editServer ? <form className="server-form"
        onSubmit={(e) => { e.preventDefault(); void run(async () => {
          const next = await invoke<Snapshot>("set_server_url", { url: server });
          setState(next); setEditServer(false);
        }); }}>
        <label htmlFor="server">MoonBridge server</label>
        <input id="server" type="url" value={server} onChange={(e) => setServer(e.target.value)}
          placeholder="https://your-staging-server.example" required />
        <p>Enter the address provided by your administrator. HTTPS is required.</p>
        <button className="button primary" disabled={busy}>Save server</button>
        {state.serverUrl && <button className="text-button" type="button"
          onClick={() => { setServer(state.serverUrl); setEditServer(false); }}>Cancel</button>}
      </form> : <>
        <div className="instruction"><span>1</span><div><strong>Clock in on MoonBridge</strong>
          <p>Use your own web account and open a shift.</p></div></div>
        <div className="instruction"><span>2</span><div><strong>Pair this computer</strong>
          <p>Generate a short code, then approve it in the web app.</p></div></div>
        <button className="button primary wide" disabled={busy} onClick={() => void run(async () => {
          const result = await invoke<{code: string; expiresInSeconds: number}>("start_pairing");
          setCode({ code: result.code, expiresAt: Date.now() + result.expiresInSeconds * 1000 });
        })}>Generate pairing code</button>
        <button className="text-button" onClick={() => setEditServer(true)}>Change server</button>
      </>)}
      {code && <section className="pairing-panel" aria-label="Pairing code">
        <span className="field-label">One-time pairing code</span>
        <div className="pair-code" aria-label={code.code}>{code.code.slice(0, 3)} <span>{code.code.slice(3)}</span></div>
        <p>Expires in {String(Math.floor(remaining / 60)).padStart(2, "0")}:{String(remaining % 60).padStart(2, "0")}</p>
        <div className="waiting"><span className="spinner" />Waiting for approval in MoonBridge</div>
        <button className="text-button" onClick={() => setCode(null)}>Cancel pairing</button>
      </section>}
      {paired && <>
        <section className={`activity-panel panel-${state.phase}`}>
          <span className="field-label">Current input gap</span>
          <strong className="input-time">{gap}</strong>
          <span>Idle after five minutes without keyboard or mouse input</span>
        </section>
        <dl className="details">
          <div><dt>Worker</dt><dd>{state.workerName || state.userId}</dd></div>
          <div><dt>Shift</dt><dd title={state.shiftId || ""}>{state.shiftId?.slice(0, 12)}…</dd></div>
          <div><dt>Waiting to sync</dt><dd>{state.pendingCount}</dd></div>
          <div><dt>Last sync</dt><dd>{state.lastSyncMs ? new Date(state.lastSyncMs).toLocaleTimeString() : "Not yet"}</dd></div>
        </dl>
        {handoff ? <div className="handoff-confirm"><strong>Stop tracking this worker?</strong>
          <p>Unsent intervals will be held for review. The next worker must pair online.</p>
          <div><button className="button danger" disabled={busy} onClick={() => void run(async () => {
            setState(await invoke<Snapshot>("change_worker")); setCode(null); setHandoff(false);
          })}>Stop and change worker</button>
            <button className="button secondary" onClick={() => setHandoff(false)}>Cancel</button></div>
        </div> : <button className="button secondary wide" onClick={() => setHandoff(true)}>Change worker</button>}
      </>}
      {state.heldCount > 0 && <p className="held-note">{state.heldCount} earlier interval{state.heldCount === 1 ? "" : "s"} held for review.</p>}
      <p className="privacy">Only activity intervals are collected. No screenshots, typed text, or app content.</p>
    </div>
    <footer className="footer"><span>{state.serverUrl || "Server not set"}</span>
      <button className="text-button" disabled={!state.serverUrl}
        onClick={() => state.serverUrl && void openUrl(state.serverUrl)}>Open MoonBridge ↗</button>
    </footer>
  </main>;
}

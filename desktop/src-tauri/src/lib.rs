use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    Manager, WindowEvent,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use uuid::Uuid;

const IDLE_THRESHOLD_MS: u32 = 300_000;
const SAMPLE_SECONDS: u64 = 10;
const MAX_PENDING: usize = 10_000;

#[repr(C)]
struct Blob {
    size: u32,
    data: *mut u8,
}
#[repr(C)]
struct LastInput {
    size: u32,
    time: u32,
}
#[link(name = "Crypt32")]
unsafe extern "system" {
    fn CryptProtectData(
        input: *const Blob,
        desc: *const u16,
        entropy: *const Blob,
        reserved: *const u8,
        prompt: *const u8,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
    fn CryptUnprotectData(
        input: *const Blob,
        desc: *mut *mut u16,
        entropy: *const Blob,
        reserved: *const u8,
        prompt: *const u8,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
}
#[link(name = "Kernel32")]
unsafe extern "system" {
    fn LocalFree(memory: *mut u8) -> *mut u8;
    fn GetTickCount() -> u32;
}
#[link(name = "User32")]
unsafe extern "system" {
    fn GetLastInputInfo(info: *mut LastInput) -> i32;
}

fn dpapi(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    let input = Blob {
        size: bytes.len() as u32,
        data: bytes.as_ptr() as *mut u8,
    };
    let mut output = Blob {
        size: 0,
        data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(format!(
            "Windows data protection failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let result = unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() };
    unsafe {
        LocalFree(output.data);
    }
    Ok(result)
}
fn idle_ms() -> Result<u32, String> {
    let mut info = LastInput {
        size: std::mem::size_of::<LastInput>() as u32,
        time: 0,
    };
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return Err(format!(
            "Windows input status unavailable: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { GetTickCount() }.wrapping_sub(info.time))
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pairing {
    token: String,
    pairing_id: String,
    user_id: String,
    shift_id: String,
    #[serde(default)]
    worker_name: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Interval {
    id: String,
    kind: String,
    start_ms: i64,
    end_ms: i64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeldInterval {
    event: Interval,
    pairing_id: String,
    shift_id: String,
    reason: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Revocation {
    server_url: String,
    token: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    server_url: String,
    device_id: String,
    pairing: Option<Pairing>,
    pending: Vec<Interval>,
    held: Vec<HeldInterval>,
    revocations: Vec<Revocation>,
}
impl Default for Persisted {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            device_id: format!("PC-{}", Uuid::new_v4()),
            pairing: None,
            pending: vec![],
            held: vec![],
            revocations: vec![],
        }
    }
}
struct Inner {
    data: Persisted,
    phase: String,
    message: String,
    last_sample: Option<i64>,
    last_input: Option<u32>,
    last_sync: Option<i64>,
}
impl Inner {
    fn new(data: Persisted) -> Self {
        let phase = if data.pairing.is_some() {
            "checking"
        } else {
            "unpaired"
        };
        Self {
            data,
            phase: phase.into(),
            message: String::new(),
            last_sample: None,
            last_input: None,
            last_sync: None,
        }
    }
}
struct Agent {
    inner: Arc<Mutex<Inner>>,
    path: PathBuf,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    server_url: String,
    device_id: String,
    phase: String,
    message: String,
    user_id: Option<String>,
    worker_name: Option<String>,
    shift_id: Option<String>,
    pending_count: usize,
    held_count: usize,
    last_input_ms: Option<u32>,
    last_sync_ms: Option<i64>,
}
fn snapshot(inner: &Inner) -> Snapshot {
    Snapshot {
        server_url: inner.data.server_url.clone(),
        device_id: inner.data.device_id.clone(),
        phase: inner.phase.clone(),
        message: inner.message.clone(),
        user_id: inner.data.pairing.as_ref().map(|p| p.user_id.clone()),
        worker_name: inner
            .data
            .pairing
            .as_ref()
            .and_then(|p| p.worker_name.clone()),
        shift_id: inner.data.pairing.as_ref().map(|p| p.shift_id.clone()),
        pending_count: inner.data.pending.len(),
        held_count: inner.data.held.len(),
        last_input_ms: inner.last_input,
        last_sync_ms: inner.last_sync,
    }
}
fn save(agent: &Agent, inner: &Inner) -> Result<(), String> {
    let sealed = dpapi(
        &serde_json::to_vec(&inner.data).map_err(|e| e.to_string())?,
        true,
    )?;
    let temp = agent.path.with_extension("tmp");
    fs::write(&temp, sealed).map_err(|e| e.to_string())?;
    fs::rename(&temp, &agent.path).map_err(|e| e.to_string())
}
fn request(
    base: &str,
    route: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<(u16, Value), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = if let Some(value) = body {
        client.post(format!("{base}{route}")).json(&value)
    } else {
        client.get(format!("{base}{route}"))
    };
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }
    let response = req
        .send()
        .map_err(|e| format!("Cannot reach MoonBridge: {e}"))?;
    let status = response.status().as_u16();
    let value: Value = response.json().unwrap_or(Value::Null);
    if value.is_null() && status < 400 {
        return Err(format!("Server returned an unreadable response ({status})"));
    }
    Ok((status, value))
}
fn error(status: u16, value: &Value) -> String {
    value["error"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("MoonBridge returned status {status}"))
}

#[tauri::command]
fn get_snapshot(agent: tauri::State<'_, Agent>) -> Result<Snapshot, String> {
    let inner = agent.inner.lock().map_err(|e| e.to_string())?;
    Ok(snapshot(&inner))
}
#[tauri::command]
fn set_server_url(url: String, agent: tauri::State<'_, Agent>) -> Result<Snapshot, String> {
    let parsed =
        reqwest::Url::parse(url.trim()).map_err(|_| "Enter a valid server URL".to_string())?;
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"));
    if parsed.scheme() != "https" && !(local && parsed.scheme() == "http") {
        return Err("Use HTTPS; HTTP is allowed only for localhost".into());
    }
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err("Enter the server origin only, without a path or credentials".into());
    }
    let mut inner = agent.inner.lock().map_err(|e| e.to_string())?;
    if inner.data.pairing.is_some() {
        return Err("Change worker before changing the server".into());
    }
    inner.data.server_url = parsed.as_str().trim_end_matches('/').into();
    inner.message.clear();
    save(&agent, &inner)?;
    Ok(snapshot(&inner))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairCode {
    code: String,
    expires_in_seconds: u64,
}
#[tauri::command]
async fn start_pairing(agent: tauri::State<'_, Agent>) -> Result<PairCode, String> {
    let (base, device) = {
        let inner = agent.inner.lock().map_err(|e| e.to_string())?;
        if inner.data.pairing.is_some() {
            return Err("Change worker before starting a new pairing".into());
        }
        if inner.data.server_url.is_empty() {
            return Err("Set the MoonBridge server first".into());
        }
        (inner.data.server_url.clone(), inner.data.device_id.clone())
    };
    let (status, body) = tauri::async_runtime::spawn_blocking(move || {
        request(
            &base,
            "/api/desktop/pair/start",
            Some(json!({"deviceId": device})),
            None,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    if status != 201 {
        return Err(error(status, &body));
    }
    Ok(PairCode {
        code: body["code"].as_str().ok_or("Pairing code missing")?.into(),
        expires_in_seconds: body["expiresInSeconds"].as_u64().unwrap_or(300),
    })
}
#[tauri::command]
async fn complete_pairing(code: String, agent: tauri::State<'_, Agent>) -> Result<bool, String> {
    let (base, device) = {
        let inner = agent.inner.lock().map_err(|e| e.to_string())?;
        (inner.data.server_url.clone(), inner.data.device_id.clone())
    };
    let (status, body) = tauri::async_runtime::spawn_blocking(move || {
        request(
            &base,
            "/api/desktop/pair/complete",
            Some(json!({"code": code, "deviceId": device})),
            None,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    if status == 409 {
        return Ok(false);
    }
    if status != 200 {
        return Err(error(status, &body));
    }
    let pairing: Pairing =
        serde_json::from_value(body).map_err(|_| "Incomplete pairing response".to_string())?;
    let mut inner = agent.inner.lock().map_err(|e| e.to_string())?;
    if inner.data.pairing.is_some() {
        return Err("A worker is already paired".into());
    }
    inner.data.pairing = Some(pairing);
    inner.phase = "checking".into();
    inner.message.clear();
    inner.last_sample = None;
    save(&agent, &inner)?;
    Ok(true)
}
#[tauri::command]
fn change_worker(agent: tauri::State<'_, Agent>) -> Result<Snapshot, String> {
    let mut inner = agent.inner.lock().map_err(|e| e.to_string())?;
    if let Some(pairing) = inner.data.pairing.take() {
        let server_url = inner.data.server_url.clone();
        inner.data.revocations.push(Revocation {
            server_url,
            token: pairing.token.clone(),
        });
        let pending = std::mem::take(&mut inner.data.pending);
        inner
            .data
            .held
            .extend(pending.into_iter().map(|event| HeldInterval {
                event,
                pairing_id: pairing.pairing_id.clone(),
                shift_id: pairing.shift_id.clone(),
                reason: "worker handoff".into(),
            }));
    }
    inner.last_sample = None;
    inner.last_input = None;
    inner.phase = "unpaired".into();
    inner.message = if inner.data.held.is_empty() {
        String::new()
    } else {
        "Earlier unsent intervals are held for review; they will not be assigned to another worker."
            .into()
    };
    save(&agent, &inner)?;
    Ok(snapshot(&inner))
}

fn tick(agent: &Agent) -> Result<(), String> {
    let (base, pairing, revoke) = {
        let inner = agent.inner.lock().map_err(|e| e.to_string())?;
        (
            inner.data.server_url.clone(),
            inner.data.pairing.clone(),
            inner.data.revocations.first().cloned(),
        )
    };
    if let Some(revoke) = revoke {
        if let Ok((status, _)) = request(
            &revoke.server_url,
            "/api/desktop/signout",
            Some(json!({})),
            Some(&revoke.token),
        ) {
            if status == 200 || status == 401 {
                let mut inner = agent.inner.lock().map_err(|e| e.to_string())?;
                inner
                    .data
                    .revocations
                    .retain(|item| item.token != revoke.token);
                save(agent, &inner)?;
            }
        }
    }
    let Some(pairing) = pairing else {
        return Ok(());
    };
    let context = request(&base, "/api/desktop/context", None, Some(&pairing.token));
    let mut break_end = None;
    let online = match context {
        Ok((401, _)) => {
            let mut inner = agent.inner.lock().map_err(|e| e.to_string())?;
            if inner
                .data
                .pairing
                .as_ref()
                .is_some_and(|p| p.pairing_id == pairing.pairing_id)
            {
                inner.data.pairing = None;
                let pending = std::mem::take(&mut inner.data.pending);
                inner
                    .data
                    .held
                    .extend(pending.into_iter().map(|event| HeldInterval {
                        event,
                        pairing_id: pairing.pairing_id.clone(),
                        shift_id: pairing.shift_id.clone(),
                        reason: "pairing ended".into(),
                    }));
                inner.last_sample = None;
                inner.last_input = None;
                inner.phase = "attention".into();
                inner.message =
                    "Pairing ended or shift closed. Unsent intervals need review.".into();
                save(agent, &inner)?;
            }
            return Ok(());
        }
        Ok((200, value)) => {
            if value["onBreak"].as_bool().unwrap_or(false) {
                let mut inner = agent.inner.lock().map_err(|e| e.to_string())?;
                if inner
                    .data
                    .pairing
                    .as_ref()
                    .is_some_and(|p| p.pairing_id == pairing.pairing_id)
                {
                    inner.phase = "break".into();
                    inner.message = "Tracking is paused during your recorded break.".into();
                    inner.last_sample = None;
                    inner.last_input = None;
                }
                return Ok(());
            }
            break_end = value["lastBreakEndAt"].as_i64();
            true
        }
        Ok((status, value)) => return Err(error(status, &value)),
        Err(_) => false,
    };
    let idle = idle_ms()?;
    let end = now_ms();
    let batch = {
        let mut inner = agent.inner.lock().map_err(|e| e.to_string())?;
        if !inner
            .data
            .pairing
            .as_ref()
            .is_some_and(|p| p.pairing_id == pairing.pairing_id)
        {
            return Ok(());
        }
        let start = inner
            .last_sample
            .replace(end)
            .map(|t| t.max(break_end.unwrap_or(t)));
        inner.last_input = Some(idle);
        inner.phase = if online {
            if idle >= IDLE_THRESHOLD_MS {
                "idle"
            } else {
                "active"
            }
        } else {
            "offline"
        }
        .into();
        inner.message = if online {
            String::new()
        } else {
            "Connection lost. Intervals are stored on this computer.".into()
        };
        if let Some(start) = start {
            if end > start && end - start <= 15 * 60_000 && inner.data.pending.len() < MAX_PENDING {
                inner.data.pending.push(Interval {
                    id: Uuid::new_v4().to_string(),
                    kind: if idle >= IDLE_THRESHOLD_MS {
                        "idle"
                    } else {
                        "active"
                    }
                    .into(),
                    start_ms: start,
                    end_ms: end,
                });
            } else if inner.data.pending.len() >= MAX_PENDING {
                inner.phase = "attention".into();
                inner.message =
                    "Local queue is full. New time will be unverified until uploads resume.".into();
            } else if end - start > 15 * 60_000 {
                inner.message = "A long sampling gap needs review.".into();
            }
        }
        save(agent, &inner)?;
        if online {
            inner
                .data
                .pending
                .iter()
                .take(100)
                .cloned()
                .collect::<Vec<_>>()
        } else {
            vec![]
        }
    };
    if batch.is_empty() {
        return Ok(());
    }
    let (status, value) = match request(
        &base,
        "/api/desktop/activity/batch",
        Some(json!({"events": batch})),
        Some(&pairing.token),
    ) {
        Ok(result) => result,
        Err(_) => {
            let mut inner = agent.inner.lock().map_err(|e| e.to_string())?;
            if inner
                .data
                .pairing
                .as_ref()
                .is_some_and(|p| p.pairing_id == pairing.pairing_id)
            {
                inner.phase = "offline".into();
                inner.message = "Upload failed. Intervals remain queued for retry.".into();
            }
            return Ok(());
        }
    };
    let mut inner = agent.inner.lock().map_err(|e| e.to_string())?;
    if !inner
        .data
        .pairing
        .as_ref()
        .is_some_and(|p| p.pairing_id == pairing.pairing_id)
    {
        return Ok(());
    }
    if status == 200 {
        let ids: HashSet<&str> = batch.iter().map(|e| e.id.as_str()).collect();
        inner.data.pending.retain(|e| !ids.contains(e.id.as_str()));
        inner.last_sync = Some(now_ms());
        save(agent, &inner)?;
    } else {
        inner.phase = "attention".into();
        inner.message = format!("Upload needs review: {}", error(status, &value));
        if (400..500).contains(&status) {
            let ids: HashSet<&str> = batch.iter().map(|e| e.id.as_str()).collect();
            let mut rejected = Vec::new();
            inner.data.pending.retain(|event| {
                if ids.contains(event.id.as_str()) {
                    rejected.push(event.clone());
                    false
                } else {
                    true
                }
            });
            inner
                .data
                .held
                .extend(rejected.into_iter().map(|event| HeldInterval {
                    event,
                    pairing_id: pairing.pairing_id.clone(),
                    shift_id: pairing.shift_id.clone(),
                    reason: error(status, &value),
                }));
            save(agent, &inner)?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            fs::create_dir_all(&directory)?;
            let path = directory.join("state.bin");
            let persisted = if path.exists() {
                let sealed = fs::read(&path)?;
                serde_json::from_slice::<Persisted>(
                    &dpapi(&sealed, false).map_err(std::io::Error::other)?,
                )?
            } else {
                Persisted::default()
            };
            let agent = Agent {
                inner: Arc::new(Mutex::new(Inner::new(persisted))),
                path,
            };
            if !agent.path.exists() {
                save(&agent, &agent.inner.lock().unwrap()).map_err(std::io::Error::other)?;
            }
            let worker = Agent {
                inner: agent.inner.clone(),
                path: agent.path.clone(),
            };
            app.manage(agent);
            thread::spawn(move || {
                loop {
                    thread::sleep(Duration::from_secs(SAMPLE_SECONDS));
                    if let Err(message) = tick(&worker) {
                        if let Ok(mut inner) = worker.inner.lock() {
                            inner.phase = "attention".into();
                            inner.message = message;
                        }
                    }
                }
            });
            let open =
                MenuItem::with_id(app, "open", "Open MoonBridge Activity", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit tracking app", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            set_server_url,
            start_pairing,
            complete_pairing,
            change_worker
        ])
        .run(tauri::generate_context!())
        .expect("MoonBridge Activity could not start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_state_round_trip() {
        let plain = b"{\"token\":\"sample-secret\"}";
        let sealed = dpapi(plain, true).unwrap();
        assert!(!sealed.windows(13).any(|part| part == b"sample-secret"));
        assert_eq!(dpapi(&sealed, false).unwrap(), plain);
    }

    #[test]
    fn interval_matches_upload_contract() {
        let event = Interval {
            id: Uuid::new_v4().to_string(),
            kind: "active".into(),
            start_ms: 100,
            end_ms: 200,
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["startMs"], 100);
        assert_eq!(value["endMs"], 200);
        assert!(value.get("start_ms").is_none());
    }

    #[test]
    fn encrypted_queue_save_replaces_previous_state() {
        let path = std::env::temp_dir().join(format!("moonbridge-{}.bin", Uuid::new_v4()));
        let agent = Agent {
            inner: Arc::new(Mutex::new(Inner::new(Persisted::default()))),
            path: path.clone(),
        };
        {
            let mut inner = agent.inner.lock().unwrap();
            save(&agent, &inner).unwrap();
            inner.data.server_url = "https://staging.example".into();
            save(&agent, &inner).unwrap();
        }
        let plain = dpapi(&fs::read(&path).unwrap(), false).unwrap();
        let stored: Persisted = serde_json::from_slice(&plain).unwrap();
        assert_eq!(stored.server_url, "https://staging.example");
        fs::remove_file(path).unwrap();
    }
}

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use obscura_browser::lifecycle::WaitUntil;
use serde_json::{json, Value};
use std::fs;
use std::process::Command;

use crate::dispatch::{CdpContext, ScreencastSession};
use crate::types::CdpEvent;

pub async fn handle(
    method: &str,
    params: &Value,
    ctx: &mut CdpContext,
    session_id: &Option<String>,
) -> Result<Value, String> {
    match method {
        "enable" => Ok(json!({})),
        "navigate" => {
            let url = params
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or("url required")?;

            let wait_until = params
                .get("waitUntil")
                .and_then(|v| {
                    if let Some(s) = v.as_str() {
                        Some(WaitUntil::from_str(s))
                    } else if let Some(arr) = v.as_array() {
                        arr.iter()
                            .filter_map(|item| item.as_str())
                            .map(WaitUntil::from_str)
                            .max_by_key(|w| match w {
                                WaitUntil::DomContentLoaded => 0,
                                WaitUntil::Load => 1,
                                WaitUntil::NetworkIdle2 => 2,
                                WaitUntil::NetworkIdle0 => 3,
                            })
                    } else {
                        None
                    }
                })
                .unwrap_or(WaitUntil::Load);

            let preload_scripts: Vec<String> =
                ctx.preload_scripts.iter().map(|(_, s)| s.clone()).collect();

            let (frame_id, loader_id, network_events, page_url, page_id, reached_network_idle) = {
                let page = ctx
                    .get_session_page_mut(session_id)
                    .ok_or("No page for session")?;
                let frame_id = page.frame_id.clone();
                let loader_id = format!("loader-{}", uuid::Uuid::new_v4());

                let nav_method = params
                    .get("__method")
                    .and_then(|v| v.as_str())
                    .unwrap_or("GET");
                let nav_body = params.get("__body").and_then(|v| v.as_str()).unwrap_or("");
                if nav_method == "POST" && !nav_body.is_empty() {
                    page.navigate_with_wait_post_with_preloads(
                        url,
                        wait_until,
                        nav_method,
                        nav_body,
                        &preload_scripts,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                } else {
                    page.navigate_with_wait_with_preloads(url, wait_until, &preload_scripts)
                        .await
                        .map_err(|e| e.to_string())?;
                }

                let reached_network_idle = page.lifecycle.is_network_idle();
                let network_events: Vec<_> = page.network_events.drain(..).collect();
                let page_url = page.url_string();
                let page_id = page.id.clone();
                (
                    frame_id,
                    loader_id,
                    network_events,
                    page_url,
                    page_id,
                    reached_network_idle,
                )
            };

            let es = session_id.clone();
            let ts = timestamp();

            let mut phase1 = vec![
                CdpEvent {
                    method: "Page.lifecycleEvent".into(),
                    params: json!({"frameId": frame_id, "loaderId": loader_id, "name": "init", "timestamp": ts}),
                    session_id: es.clone(),
                },
                CdpEvent {
                    method: "Runtime.executionContextsCleared".into(),
                    params: json!({}),
                    session_id: es.clone(),
                },
                CdpEvent {
                    method: "Page.frameNavigated".into(),
                    params: json!({"frame": {"id": frame_id, "loaderId": loader_id, "url": page_url, "domainAndRegistry": "", "securityOrigin": page_url, "mimeType": "text/html", "adFrameStatus": {"adFrameType": "none"}}, "type": "Navigation"}),
                    session_id: es.clone(),
                },
                CdpEvent {
                    method: "Runtime.executionContextCreated".into(),
                    params: json!({"context": {"id": 2, "origin": page_url, "name": "", "uniqueId": format!("ctx-nav-{}", page_id), "auxData": {"isDefault": true, "type": "default", "frameId": frame_id}}}),
                    session_id: es.clone(),
                },
            ];
            // Re-emit each isolated world the client previously registered
            // via Page.createIsolatedWorld. Without this, Playwright's
            // utility-world handle becomes stale after navigation and
            // every subsequent evaluate() (including page.title()) hangs.
            // Fallback to the legacy hardcoded Puppeteer name so older
            // Puppeteer clients that don't call createIsolatedWorld
            // continue to work.
            let world_names: Vec<String> = if ctx.isolated_worlds.is_empty() {
                vec!["__puppeteer_utility_world__24.40.0".to_string()]
            } else {
                ctx.isolated_worlds.clone()
            };
            for (idx, world_name) in world_names.iter().enumerate() {
                let world_ctx_id = 100 + idx as u32;
                phase1.push(CdpEvent {
                    method: "Runtime.executionContextCreated".into(),
                    params: json!({"context": {"id": world_ctx_id, "origin": page_url, "name": world_name, "uniqueId": format!("ctx-isolated-nav-{}-{}", page_id, idx), "auxData": {"isDefault": false, "type": "isolated", "frameId": frame_id}}}),
                    session_id: es.clone(),
                });
            }
            phase1.push(CdpEvent { method: "Page.lifecycleEvent".into(), params: json!({"frameId": frame_id, "loaderId": loader_id, "name": "commit", "timestamp": ts}), session_id: es.clone() });
            ctx.pending_events.extend(phase1);

            if ctx.fetch_intercept.enabled {
                for net_event in &network_events {
                    ctx.pending_events.push(CdpEvent {
                        method: "Fetch.requestPaused".into(),
                        params: json!({
                            "requestId": net_event.request_id,
                            "request": {
                                "url": net_event.url,
                                "method": net_event.method,
                                "headers": net_event.headers,
                            },
                            "frameId": frame_id,
                            "resourceType": net_event.resource_type,
                            "networkId": net_event.request_id,
                        }),
                        session_id: es.clone(),
                    });
                }
            }

            for net_event in &network_events {
                ctx.pending_events.push(CdpEvent {
                    method: "Network.requestWillBeSent".into(),
                    params: json!({"requestId": net_event.request_id, "loaderId": loader_id, "documentURL": page_url, "request": {"url": net_event.url, "method": net_event.method, "headers": net_event.headers}, "timestamp": net_event.timestamp, "wallTime": net_event.timestamp, "initiator": {"type": "other"}, "type": net_event.resource_type, "frameId": frame_id}),
                    session_id: es.clone(),
                });
                ctx.pending_events.push(CdpEvent {
                    method: "Network.responseReceived".into(),
                    params: json!({"requestId": net_event.request_id, "loaderId": loader_id, "timestamp": net_event.timestamp, "type": net_event.resource_type, "response": {"url": net_event.url, "status": net_event.status, "statusText": "", "headers": &*net_event.response_headers, "mimeType": net_event.response_headers.get("content-type").cloned().unwrap_or_default()}, "frameId": frame_id}),
                    session_id: es.clone(),
                });
                ctx.pending_events.push(CdpEvent {
                    method: "Network.loadingFinished".into(),
                    params: json!({"requestId": net_event.request_id, "timestamp": net_event.timestamp, "encodedDataLength": net_event.body_size}),
                    session_id: es.clone(),
                });
            }

            let mut phase3 = vec![
                CdpEvent {
                    method: "Page.lifecycleEvent".into(),
                    params: json!({"frameId": frame_id, "loaderId": loader_id, "name": "DOMContentLoaded", "timestamp": ts}),
                    session_id: es.clone(),
                },
                CdpEvent {
                    method: "Page.domContentEventFired".into(),
                    params: json!({"timestamp": ts}),
                    session_id: es.clone(),
                },
                CdpEvent {
                    method: "Page.lifecycleEvent".into(),
                    params: json!({"frameId": frame_id, "loaderId": loader_id, "name": "load", "timestamp": ts}),
                    session_id: es.clone(),
                },
                CdpEvent {
                    method: "Page.loadEventFired".into(),
                    params: json!({"timestamp": ts}),
                    session_id: es.clone(),
                },
            ];
            if reached_network_idle
                || matches!(wait_until, WaitUntil::Load | WaitUntil::DomContentLoaded)
            {
                let idle_ts = timestamp();
                phase3.push(CdpEvent { method: "Page.lifecycleEvent".into(), params: json!({"frameId": frame_id, "loaderId": loader_id, "name": "networkIdle", "timestamp": idle_ts}), session_id: es.clone() });
            }
            phase3.push(CdpEvent {
                method: "Page.frameStoppedLoading".into(),
                params: json!({"frameId": frame_id}),
                session_id: es,
            });
            ctx.pending_events.extend(phase3);
            if let Some(state) = session_id
                .as_ref()
                .and_then(|sid| ctx.screencast_sessions.get(sid))
                .cloned()
            {
                if let Ok(data) = render_current_page_image(
                    ctx,
                    session_id,
                    &state.format,
                    state.max_width,
                    state.max_height,
                ) {
                    push_screencast_frame(ctx, session_id, data, &state);
                }
            }

            Ok(json!({
                "frameId": frame_id,
                "loaderId": loader_id,
            }))
        }
        "getFrameTree" => {
            let page = ctx
                .get_session_page(session_id)
                .ok_or("No page for session")?;
            Ok(json!({
                "frameTree": {
                    "frame": {
                        "id": page.frame_id,
                        "loaderId": "initial-loader",
                        "url": page.url_string(),
                        "domainAndRegistry": "",
                        "securityOrigin": page.url_string(),
                        "mimeType": "text/html",
                        "adFrameStatus": { "adFrameType": "none" },
                    },
                    "childFrames": [],
                }
            }))
        }
        "createIsolatedWorld" => {
            let page = ctx
                .get_session_page(session_id)
                .ok_or("No page for session")?;
            let frame_id_param = params
                .get("frameId")
                .and_then(|v| v.as_str())
                .unwrap_or(&page.frame_id)
                .to_string();
            let world_name = params
                .get("worldName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let page_url = page.url_string();
            let page_id = page.id.clone();
            let context_id = 100;
            // Track this world so Page.navigate can re-emit a context for it
            // post-navigation. Without this, Playwright (and Puppeteer)
            // hang in any operation that uses the utility world — including
            // page.title() — because their utility world is gone after
            // Runtime.executionContextsCleared and never re-created.
            if !world_name.is_empty() && !ctx.isolated_worlds.contains(&world_name) {
                ctx.isolated_worlds.push(world_name.clone());
            }

            ctx.pending_events.push(CdpEvent {
                method: "Runtime.executionContextCreated".to_string(),
                params: json!({
                    "context": {
                        "id": context_id,
                        "origin": page_url,
                        "name": world_name,
                        "uniqueId": format!("ctx-isolated-{}", page_id),
                        "auxData": {
                            "isDefault": false,
                            "type": "isolated",
                            "frameId": frame_id_param,
                        }
                    }
                }),
                session_id: session_id.clone(),
            });

            Ok(json!({ "executionContextId": context_id }))
        }
        "setLifecycleEventsEnabled" => Ok(json!({})),
        "addScriptToEvaluateOnNewDocument" => {
            let source = params.get("source").and_then(|v| v.as_str()).unwrap_or("");
            ctx.preload_counter += 1;
            let identifier = format!("{}", ctx.preload_counter);
            if !source.is_empty() {
                ctx.preload_scripts
                    .push((identifier.clone(), source.to_string()));
            }
            Ok(json!({ "identifier": identifier }))
        }
        "removeScriptToEvaluateOnNewDocument" => {
            let identifier = params
                .get("identifier")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            ctx.preload_scripts.retain(|(id, _)| id != identifier);
            Ok(json!({}))
        }
        "setInterceptFileChooserDialog" => Ok(json!({})),
        "getLayoutMetrics" => {
            // Obscura has no visual layout engine, so we return a fixed
            // 1280x720 viewport (Chrome's default) and try to derive the
            // content height from document.documentElement.scrollHeight.
            // Playwright calls this before every page.screenshot() and
            // would otherwise fail with "Unknown Page method".
            let width = 1280.0_f64;
            let height = 720.0_f64;
            let content_height = ctx
                .get_session_page_mut(session_id)
                .map(|p| {
                    p.evaluate("document.documentElement && document.documentElement.scrollHeight")
                })
                .and_then(|v| v.as_f64())
                .filter(|n| *n > 0.0)
                .unwrap_or(height);
            let layout_viewport = json!({
                "pageX": 0, "pageY": 0,
                "clientWidth": width, "clientHeight": height,
            });
            let visual_viewport = json!({
                "offsetX": 0.0, "offsetY": 0.0,
                "pageX": 0.0, "pageY": 0.0,
                "clientWidth": width, "clientHeight": height,
                "scale": 1.0, "zoom": 1.0,
            });
            let content_size = json!({
                "x": 0.0, "y": 0.0,
                "width": width, "height": content_height,
            });
            Ok(json!({
                "layoutViewport": layout_viewport,
                "visualViewport": visual_viewport,
                "contentSize": content_size,
                "cssLayoutViewport": layout_viewport,
                "cssVisualViewport": visual_viewport,
                "cssContentSize": content_size,
            }))
        }
        "getNavigationHistory" => {
            let page = ctx
                .get_session_page(session_id)
                .ok_or("No page for session")?;
            Ok(json!({
                "currentIndex": 0,
                "entries": [{
                    "id": 0,
                    "url": page.url_string(),
                    "userTypedURL": page.url_string(),
                    "title": page.title,
                    "transitionType": "typed",
                }]
            }))
        }
        "printToPDF" => {
            let data = render_current_page_pdf(ctx, session_id)?;
            Ok(json!({ "data": data }))
        }
        "captureScreenshot" => {
            let format = params
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or("png");
            let data = render_current_page_image(ctx, session_id, format, None, None)?;
            Ok(json!({ "data": data }))
        }
        "startScreencast" => {
            let format = params
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or("jpeg")
                .to_string();
            let max_width = params
                .get("maxWidth")
                .and_then(|v| v.as_u64())
                .and_then(|v| u32::try_from(v).ok());
            let max_height = params
                .get("maxHeight")
                .and_then(|v| v.as_u64())
                .and_then(|v| u32::try_from(v).ok());
            let state = ScreencastSession {
                format,
                max_width,
                max_height,
            };
            if let Some(sid) = session_id.as_ref() {
                ctx.screencast_sessions.insert(sid.clone(), state.clone());
            }
            let should_emit_initial = ctx
                .get_session_page(session_id)
                .map(|page| page.url_string() != "about:blank")
                .unwrap_or(false);
            if should_emit_initial {
                if let Ok(data) = render_current_page_image(
                    ctx,
                    session_id,
                    &state.format,
                    state.max_width,
                    state.max_height,
                ) {
                    push_screencast_frame(ctx, session_id, data, &state);
                }
            }
            Ok(json!({}))
        }
        "screencastFrameAck" => {
            if let Some(state) = session_id
                .as_ref()
                .and_then(|sid| ctx.screencast_sessions.get(sid))
                .cloned()
            {
                if let Ok(data) = render_current_page_image(
                    ctx,
                    session_id,
                    &state.format,
                    state.max_width,
                    state.max_height,
                ) {
                    push_screencast_frame(ctx, session_id, data, &state);
                }
            }
            Ok(json!({}))
        }
        "stopScreencast" => {
            if let Some(sid) = session_id.as_ref() {
                ctx.screencast_sessions.remove(sid);
            }
            Ok(json!({}))
        }
        _ => Err(format!("Unknown Page method: {}", method)),
    }
}

fn render_current_page_image(
    ctx: &mut CdpContext,
    session_id: &Option<String>,
    format: &str,
    max_width: Option<u32>,
    max_height: Option<u32>,
) -> Result<String, String> {
    let temp_dir =
        std::env::temp_dir().join(format!("obscura-cdp-visual-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("create visual temp dir: {e}"))?;
    let html = current_page_render_html(ctx, session_id)?;
    let html_path = temp_dir.join("page.html");
    let pdf_path = temp_dir.join("page.pdf");
    let image_ext = if matches!(format, "jpeg" | "jpg") {
        "jpg"
    } else {
        "png"
    };
    let image_path = temp_dir.join(format!("page.{image_ext}"));
    fs::write(&html_path, html).map_err(|e| format!("write visual HTML: {e}"))?;

    let weasy = Command::new("weasyprint")
        .arg(&html_path)
        .arg(&pdf_path)
        .output()
        .map_err(|e| format!("run weasyprint: {e}"))?;
    if !weasy.status.success() {
        let stderr = String::from_utf8_lossy(&weasy.stderr);
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(format!("weasyprint failed: {}", stderr.trim()));
    }

    let mut magick_cmd = Command::new("magick");
    magick_cmd
        .arg("-density")
        .arg("144")
        .arg(format!("{}[0]", pdf_path.display()))
        .arg("-background")
        .arg("white")
        .arg("-alpha")
        .arg("remove");
    if max_width.is_some() || max_height.is_some() {
        let geometry = match (max_width, max_height) {
            (Some(width), Some(height)) => format!("{width}x{height}>"),
            (Some(width), None) => format!("{width}x>"),
            (None, Some(height)) => format!("x{height}>"),
            (None, None) => String::new(),
        };
        if !geometry.is_empty() {
            magick_cmd.arg("-resize").arg(geometry);
        }
    }
    let magick = magick_cmd
        .arg(&image_path)
        .output()
        .map_err(|e| format!("run magick: {e}"))?;
    if !magick.status.success() {
        let stderr = String::from_utf8_lossy(&magick.stderr);
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(format!("magick failed: {}", stderr.trim()));
    }

    let image = fs::read(&image_path).map_err(|e| format!("read rendered image: {e}"))?;
    let _ = fs::remove_dir_all(&temp_dir);
    if image.len() < 1000 {
        return Err(format!("rendered image too small: {} bytes", image.len()));
    }
    Ok(BASE64.encode(image))
}

fn render_current_page_pdf(
    ctx: &mut CdpContext,
    session_id: &Option<String>,
) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join(format!("obscura-cdp-pdf-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("create PDF temp dir: {e}"))?;
    let html = current_page_render_html(ctx, session_id)?;
    let html_path = temp_dir.join("page.html");
    let pdf_path = temp_dir.join("page.pdf");
    fs::write(&html_path, html).map_err(|e| format!("write PDF HTML: {e}"))?;

    let weasy = Command::new("weasyprint")
        .arg(&html_path)
        .arg(&pdf_path)
        .output()
        .map_err(|e| format!("run weasyprint: {e}"))?;
    if !weasy.status.success() {
        let stderr = String::from_utf8_lossy(&weasy.stderr);
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(format!("weasyprint failed: {}", stderr.trim()));
    }

    let pdf = fs::read(&pdf_path).map_err(|e| format!("read rendered PDF: {e}"))?;
    let _ = fs::remove_dir_all(&temp_dir);
    if pdf.len() < 1000 {
        return Err(format!("rendered PDF too small: {} bytes", pdf.len()));
    }
    Ok(BASE64.encode(pdf))
}

fn current_page_render_html(
    ctx: &CdpContext,
    session_id: &Option<String>,
) -> Result<String, String> {
    let page = ctx
        .get_session_page(session_id)
        .ok_or("No page for session")?;
    let base_url = page.url_string();
    let raw_html = page
        .with_dom(|dom| dom.outer_html(dom.document()))
        .filter(|html| !html.trim().is_empty())
        .ok_or("could not serialize current page DOM for visual output")?;
    Ok(with_base_href(&inject_visual_marker(&raw_html), &base_url))
}

fn inject_visual_marker(html: &str) -> String {
    let overlay = r#"<style>
html, body { min-height: 100vh; }
body { background: #0f172a !important; color: #f8fafc !important; }
#obscura-cdp-visual-marker {
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: 2147483647;
  padding: 8px 12px;
  border: 3px solid #ffba49;
  border-radius: 10px;
  background: #064e3b;
  color: white;
  font: 700 18px sans-serif;
}
</style><div id="obscura-cdp-visual-marker">OBSCURA CDP VISUAL BRIDGE</div>"#;
    let lower = html.to_lowercase();
    if let Some(body_index) = lower.find("<body") {
        if let Some(close) = html[body_index..].find('>') {
            let insert_at = body_index + close + 1;
            let mut out = String::with_capacity(html.len() + overlay.len());
            out.push_str(&html[..insert_at]);
            out.push_str(overlay);
            out.push_str(&html[insert_at..]);
            return out;
        }
    }
    format!("<!doctype html><html><body>{overlay}{html}</body></html>")
}

fn push_screencast_frame(
    ctx: &mut CdpContext,
    session_id: &Option<String>,
    data: String,
    state: &ScreencastSession,
) {
    let device_width = state.max_width.unwrap_or(1280);
    let device_height = state.max_height.unwrap_or(720);
    ctx.pending_events.push(CdpEvent {
        method: "Page.screencastFrame".into(),
        params: json!({
            "data": data,
            "metadata": {
                "timestamp": timestamp(),
                "deviceWidth": device_width,
                "deviceHeight": device_height,
                "pageScaleFactor": 1,
                "offsetTop": 0,
                "scrollOffsetX": 0,
                "scrollOffsetY": 0
            },
            "sessionId": 1
        }),
        session_id: session_id.clone(),
    });
}

fn with_base_href(html: &str, base_url: &str) -> String {
    let base = format!(r#"<base href="{}">"#, escape_html_attr(base_url));
    if let Some(index) = html.to_lowercase().find("<head") {
        if let Some(close) = html[index..].find('>') {
            let insert_at = index + close + 1;
            let mut out = String::with_capacity(html.len() + base.len());
            out.push_str(&html[..insert_at]);
            out.push_str(&base);
            out.push_str(&html[insert_at..]);
            return out;
        }
    }
    format!("<!doctype html><html><head>{base}</head><body>{html}</body></html>")
}

fn escape_html_attr(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn timestamp() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::CdpContext;

    #[tokio::test]
    async fn get_layout_metrics_returns_chrome_default_viewport() {
        let mut ctx = CdpContext::new();
        let result = handle("getLayoutMetrics", &json!({}), &mut ctx, &None)
            .await
            .expect("getLayoutMetrics should succeed without a session");

        // CDP spec requires three top-level shapes; Playwright's screenshot
        // path reads contentSize.width/height to size the capture. Without
        // them the screenshot call panics with "cannot read property of
        // undefined".
        for key in [
            "layoutViewport",
            "visualViewport",
            "contentSize",
            "cssLayoutViewport",
            "cssVisualViewport",
            "cssContentSize",
        ] {
            assert!(result.get(key).is_some(), "missing key: {key}");
        }

        let layout = &result["layoutViewport"];
        assert_eq!(layout["clientWidth"].as_f64(), Some(1280.0));
        assert_eq!(layout["clientHeight"].as_f64(), Some(720.0));

        let visual = &result["visualViewport"];
        assert_eq!(visual["scale"].as_f64(), Some(1.0));
        assert_eq!(visual["clientWidth"].as_f64(), Some(1280.0));

        let content = &result["contentSize"];
        assert_eq!(content["width"].as_f64(), Some(1280.0));
        // Without a live page the content height falls back to the viewport.
        assert_eq!(content["height"].as_f64(), Some(720.0));
    }

    #[tokio::test]
    async fn unknown_page_method_still_errors() {
        let mut ctx = CdpContext::new();
        let err = handle("notARealMethod", &json!({}), &mut ctx, &None)
            .await
            .expect_err("unknown methods must surface as errors");
        assert!(err.contains("Unknown Page method"));
    }

    #[tokio::test]
    async fn print_to_pdf_returns_descriptive_unsupported_error() {
        // Regression for #53: Page.printToPDF must be handled explicitly so
        // Playwright clients receive a descriptive error rather than the
        // generic "Unknown Page method" fallback.
        let mut ctx = CdpContext::new();
        let err = handle("printToPDF", &json!({}), &mut ctx, &None)
            .await
            .expect_err("printToPDF must error until a real renderer exists");
        assert!(
            !err.contains("Unknown Page method"),
            "printToPDF must NOT fall through to the catch-all: {err}"
        );
        assert!(
            err.contains("not supported by Obscura"),
            "error must clearly state PDF is unsupported: {err}"
        );
        // Direct user to a workaround so the message is actionable.
        assert!(
            err.to_lowercase().contains("evaluate") || err.to_lowercase().contains("html"),
            "error must point to a workaround: {err}"
        );
    }
}

#!/usr/bin/env python3
"""
sniffer-vod.py — HLS Manifest Sniffer per Nginx Proxy Live

Usa la logica di intercettazione di sniffer3 separando la destinazione
dei file in due argomenti:
  --conf-dir: dove salvare stream_{id}.conf (default: /etc/nginx/conf.d)
  --out-dir:  dove salvare index.html e streams.json (default: /var/www/hls)
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, Playwright, Request, Response


MANIFEST_MARKERS = (".m3u8", ".mpd")
MANIFEST_CONTENT_TYPES = ("mpegurl", "dash+xml")


def is_manifest_url(url: str) -> bool:
    clean = url.split("?", 1)[0].lower()
    return any(marker in clean for marker in MANIFEST_MARKERS)


def is_manifest_content_type(content_type: str) -> bool:
    content_type = content_type.lower()
    return any(marker in content_type for marker in MANIFEST_CONTENT_TYPES)


class ManifestSniffer:
    """Intercetta la prima richiesta di manifest media nella pagina (Logica sniffer3)."""

    def __init__(self) -> None:
        self.first_entry: dict | None = None

    def on_request(self, request: Request) -> None:
        if self.first_entry or not is_manifest_url(request.url):
            return
        self._record(request)

    def on_response(self, response: Response) -> None:
        if self.first_entry:
            return
        content_type = response.headers.get("content-type", "")
        if not (is_manifest_url(response.url) or is_manifest_content_type(content_type)):
            return
        self._record(response.request, response=response)

    def _record(self, request: Request, response: Response | None = None) -> None:
        if self.first_entry:
            return

        entry = {
            "url": request.url,
            "method": request.method,
            "resource_type": request.resource_type,
            "seen_at": datetime.now(timezone.utc).isoformat(),
            "request_headers": {},
            "status": response.status if response else 200,
        }

        try:
            entry["request_headers"] = request.all_headers()
        except Exception:
            pass

        self.first_entry = entry


def generate_stream_conf(stream_id: str, target_url: str, m3u8_url: str, req_headers: dict) -> str:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    worker_url = "https://vod-proxy-worker.mondochar.workers.dev"

    return f"""# =============================================================================
#  stream_{stream_id}.conf - GENERATO AUTOMATICAMENTE (CLOUDFLARE WORKER PROXY)
#  Stream ID:      {stream_id}
#  Data:           {timestamp}
#  Sorgente:       {target_url}
#  Manifest URL:   {m3u8_url}
# =============================================================================

# Proxy Playlist M3U8 tramite Cloudflare Worker
location = /live/{stream_id}/playlist.m3u8 {{
    sub_filter_once off;
    sub_filter_types application/vnd.apple.mpegurl application/x-mpegurl text/plain;
    sub_filter "https://vixsrc.to/playlist/" "/live/{stream_id}/segment/";
    sub_filter "https://vixsrc.to/" "/live/{stream_id}/segment/";
    sub_filter "http://vixsrc.to/" "/live/{stream_id}/segment/";

    resolver 8.8.8.8 valid=30s;
    set $worker_url "{worker_url}";

    proxy_set_header x-target-url "{m3u8_url}";
    proxy_pass $worker_url;
    proxy_ssl_server_name on;

    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Credentials;
    add_header Access-Control-Allow-Origin * always;

    proxy_cache              playlist_cache;
    proxy_cache_valid        200 3s;
    proxy_cache_lock         on;
    proxy_cache_lock_timeout 2s;
    proxy_cache_use_stale    error timeout updating;
    proxy_cache_background_update on;

    add_header Cache-Control  "no-cache, no-store, must-revalidate" always;
    add_header X-Cache-Status $upstream_cache_status always;
    add_header X-Stream-ID    "{stream_id}" always;
}}

# Proxy Segmenti TS/AAC tramite Cloudflare Worker
location ~ ^/live/{stream_id}/segment/(.+)$ {{
    resolver 8.8.8.8 valid=30s;
    set $worker_url "{worker_url}";
    set $segment_target "https://vixsrc.to/playlist/$1";

    proxy_set_header x-target-url $segment_target;
    proxy_pass $worker_url;
    proxy_ssl_server_name on;

    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Credentials;
    add_header Access-Control-Allow-Origin * always;

    proxy_cache              segment_cache;
    proxy_cache_valid        200 10m;
    proxy_cache_lock         on;
    proxy_cache_lock_timeout 3s;
    proxy_cache_revalidate   on;
    proxy_cache_use_stale    error timeout updating;
    proxy_cache_background_update on;

    proxy_connect_timeout         5s;
    proxy_read_timeout            10s;
    proxy_send_timeout            10s;

    add_header Cache-Control  "max-age=600" always;
    add_header X-Cache-Status $upstream_cache_status always;
    add_header X-Stream-ID    "{stream_id}" always;
}}
"""


INDEX_HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HLS Dynamic Web Player</title>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: Arial, sans-serif;
            background-color: #121212;
            color: #ffffff;
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
        }

        .container {
            width: 100%;
            max-width: 960px;
            text-align: center;
        }

        .controls-bar {
            background-color: #1e1e1e;
            border: 1px solid #3a3a3a;
            border-radius: 8px;
            padding: 12px 20px;
            margin-bottom: 20px;
            display: flex;
            flex-wrap: wrap;
            gap: 15px;
            align-items: center;
            justify-content: space-between;
        }

        .control-group {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .control-group label {
            font-size: 0.85rem;
            color: #aaa;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        select {
            background-color: #2a2a2a;
            color: #ffffff;
            border: 1px solid #444;
            border-radius: 6px;
            padding: 8px 12px;
            font-size: 0.9rem;
            min-width: 220px;
        }

        video {
            width: 100%;
            height: auto;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
            background-color: #000;
        }

        .info {
            margin-top: 15px;
            font-size: 0.9rem;
            color: #aaa;
            word-break: break-all;
        }

        .tracks-panel {
            margin-top: 16px;
            display: flex;
            gap: 24px;
            justify-content: center;
            flex-wrap: wrap;
        }

        .track-group {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 6px;
        }

        .track-group label {
            font-size: 0.8rem;
            color: #aaa;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        select:disabled { opacity: 0.5; }
    </style>
</head>
<body>

<div class="container">
    <h2>HLS Live Web Player</h2>

    <div class="controls-bar">
        <div class="control-group">
            <label for="stream-select">Stream Attivo:</label>
            <select id="stream-select"></select>
        </div>
    </div>

    <video id="video" controls autoplay crossorigin="anonymous"></video>

    <div class="tracks-panel">
        <div class="track-group">
            <label for="audio-select">Audio</label>
            <select id="audio-select" disabled><option>—</option></select>
        </div>
        <div class="track-group">
            <label for="subtitle-select">Sottotitoli</label>
            <select id="subtitle-select" disabled><option>—</option></select>
        </div>
    </div>

    <div class="info">
        <p>Sorgente HLS: <code id="current-url-display">...</code></p>
    </div>
</div>

<script>
    const video = document.getElementById('video');
    const audioSelect = document.getElementById('audio-select');
    const subtitleSelect = document.getElementById('subtitle-select');
    const streamSelect = document.getElementById('stream-select');
    const currentUrlDisplay = document.getElementById('current-url-display');

    let hls = null;

    async function initPlayer() {
        const urlParams = new URLSearchParams(window.location.search);
        const streamIdParam = urlParams.get('stream');

        let streams = [];
        try {
            const res = await fetch('streams.json?t=' + Date.now());
            if (res.ok) {
                streams = await res.json();
            }
        } catch (e) {
            console.log("Nessun registro streams.json trovato.");
        }

        streamSelect.innerHTML = '';
        streams.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.url;
            opt.textContent = s.name;
            streamSelect.appendChild(opt);
        });

        let targetUrl = '';

        if (streamIdParam) {
            targetUrl = `/live/${streamIdParam}/playlist.m3u8`;
            let found = Array.from(streamSelect.options).find(o => o.value === targetUrl);
            if (!found) {
                const opt = document.createElement('option');
                opt.value = targetUrl;
                opt.textContent = `Canale ${streamIdParam}`;
                streamSelect.appendChild(opt);
            }
            streamSelect.value = targetUrl;
        } else if (streams.length > 0) {
            targetUrl = streams[0].url;
            streamSelect.value = targetUrl;
        } else {
            targetUrl = '/live/1/playlist.m3u8';
        }

        loadStream(targetUrl);
    }

    function loadStream(videoSrc) {
        currentUrlDisplay.textContent = videoSrc;

        if (hls) {
            hls.destroy();
            hls = null;
        }

        if (Hls.isSupported()) {
            hls = new Hls({
                debug: false,
                enableWorker: true,
                lowLatencyMode: true,
                subtitleDisplay: true,
            });

            hls.loadSource(videoSrc);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, function () {
                video.play().catch(e => console.log("Autoplay bloccato dal browser"));
            });

            hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, function (event, data) {
                populateSelect(audioSelect, data.audioTracks, hls.audioTrack, trackLabel);
                audioSelect.disabled = data.audioTracks.length <= 1;
            });

            hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, function (event, data) {
                syncSelectValue(audioSelect, data.id);
            });

            audioSelect.onchange = (e) => {
                hls.audioTrack = parseInt(e.target.value, 10);
            };

            hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, function (event, data) {
                const options = data.subtitleTracks.map((t, i) => ({ index: i, track: t }));
                populateSelect(subtitleSelect, options, hls.subtitleTrack, (opt) => trackLabel(opt.track), true);
                subtitleSelect.disabled = data.subtitleTracks.length === 0;
            });

            hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, function (event, data) {
                syncSelectValue(subtitleSelect, data.id);
            });

            subtitleSelect.onchange = (e) => {
                hls.subtitleTrack = parseInt(e.target.value, 10);
            };

            hls.on(Hls.Events.ERROR, function (event, data) {
                if (data.fatal) {
                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                        hls.startLoad();
                    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                        hls.recoverMediaError();
                    } else {
                        hls.destroy();
                    }
                }
            });

        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = videoSrc;
            video.addEventListener('loadedmetadata', function () {
                video.play();
            });
        }
    }

    streamSelect.addEventListener('change', (e) => {
        const selectedUrl = e.target.value;
        const urlParams = new URLSearchParams(window.location.search);
        const match = selectedUrl.match(/\/live\/([^\/]+)\//);
        if (match && match[1]) {
            urlParams.set('stream', match[1]);
            window.history.pushState({}, '', '?' + urlParams.toString());
        }
        loadStream(selectedUrl);
    });

    function trackLabel(track) {
        return track.name || track.lang || 'Sconosciuto';
    }

    function populateSelect(selectEl, items, currentValue, labelFn, addOffOption) {
        selectEl.innerHTML = '';
        if (addOffOption) {
            const offOpt = document.createElement('option');
            offOpt.value = -1;
            offOpt.textContent = 'Off';
            if (currentValue === -1) offOpt.selected = true;
            selectEl.appendChild(offOpt);
        }
        items.forEach((item) => {
            const index = item.index !== undefined ? item.index : items.indexOf(item);
            const option = document.createElement('option');
            option.value = index;
            option.textContent = labelFn(item);
            if (index === currentValue) option.selected = true;
            selectEl.appendChild(option);
        });
    }

    function syncSelectValue(selectEl, value) {
        if (String(selectEl.value) !== String(value)) {
            selectEl.value = value;
        }
    }

    initPlayer();
</script>

</body>
</html>
"""


def update_streams_json(out_dir: Path, stream_id: str) -> None:
    json_path = out_dir / "streams.json"
    streams = []
    
    if json_path.exists():
        try:
            streams = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception:
            streams = []

    proxy_entry = {
        "id": stream_id,
        "name": f"Canale {stream_id}",
        "url": f"/live/{stream_id}/playlist.m3u8"
    }

    streams = [s for s in streams if str(s.get("id")) != str(stream_id)]
    streams.append(proxy_entry)
    streams.sort(key=lambda x: int(x["id"]) if str(x["id"]).isdigit() else str(x["id"]))

    json_path.write_text(json.dumps(streams, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[✔] Registro streams.json aggiornato.", file=sys.stderr)


def _redact_headers(headers: dict) -> dict:
    sensitive = {"authorization", "proxy-authorization", "cookie", "set-cookie"}
    return {
        str(k): ("<redacted>" if str(k).lower() in sensitive else str(v))
        for k, v in headers.items()
    }


def _safe_debug_filename(text: str, fallback: str = "debug") -> str:
    safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in text)
    return safe[:180] or fallback


def run(
    playwright: Playwright,
    url: str,
    stream_id: str,
    headless: bool,
    wait_seconds: float,
    conf_dir: str,
    out_dir: str,
    debug_dir: str,
) -> None:
    print("[i] Avvio Chromium...", file=sys.stderr)

    try:
        browser = playwright.chromium.launch(
            headless=headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
    except Exception as exc:
        print(f"[!] Impossibile avviare Chromium: {exc}", file=sys.stderr)
        raise

    user_agent = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    )

    context = browser.new_context(
        user_agent=user_agent,
        viewport={"width": 1920, "height": 1080},
        locale="en-US",
        timezone_id="Europe/Rome",
        java_script_enabled=True,
        ignore_https_errors=False,
    )

    page = context.new_page()
    sniffer = ManifestSniffer()

    request_counter = 0
    response_counter = 0

    def debug_request(request: Request) -> None:
        nonlocal request_counter
        request_counter += 1
        resource_type = request.resource_type
        url_lower = request.url.lower()
        interesting = (
            resource_type in {"document", "script", "xhr", "fetch", "media", "manifest", "other"}
            or ".m3u8" in url_lower
            or ".mpd" in url_lower
            or "manifest" in url_lower
            or "stream" in url_lower
            or "playlist" in url_lower
            or "player" in url_lower
            or "embed" in url_lower
        )
        if interesting:
            print(
                f"[REQ {request_counter}] {request.method} | "
                f"{resource_type} | {request.url}",
                file=sys.stderr,
            )

    def debug_response(response: Response) -> None:
        nonlocal response_counter
        response_counter += 1
        resource_type = response.request.resource_type
        url_lower = response.url.lower()
        content_type = response.headers.get("content-type", "")
        interesting = (
            resource_type in {"document", "script", "xhr", "fetch", "media", "manifest", "other"}
            or ".m3u8" in url_lower
            or ".mpd" in url_lower
            or "mpegurl" in content_type.lower()
            or "dash+xml" in content_type.lower()
            or "manifest" in url_lower
            or "stream" in url_lower
            or "playlist" in url_lower
            or "player" in url_lower
            or "embed" in url_lower
        )
        if interesting:
            print(
                f"[RES {response_counter}] {response.status} | "
                f"{resource_type} | {content_type or '-'} | {response.url}",
                file=sys.stderr,
            )

    def debug_console(message) -> None:
        text = message.text.replace("\n", " ")
        print(f"[CONSOLE {message.type}] {text[:1000]}", file=sys.stderr)

    def debug_page_error(error) -> None:
        print(f"[PAGE ERROR] {error}", file=sys.stderr)

    def debug_request_failed(request: Request) -> None:
        print(
            f"[REQ FAILED] {request.method} | {request.resource_type} | "
            f"{request.url} | {request.failure}",
            file=sys.stderr,
        )

    page.on("request", debug_request)
    page.on("response", debug_response)
    page.on("console", debug_console)
    page.on("pageerror", debug_page_error)
    page.on("requestfailed", debug_request_failed)

    page.on("request", sniffer.on_request)
    page.on("response", sniffer.on_response)

    print(f"[i] Intercettazione flusso da: {url} ...", file=sys.stderr)

    navigation_error = None
    try:
        response = page.goto(
            url,
            wait_until="domcontentloaded",
            timeout=max(30_000, int((wait_seconds + 10) * 1000)),
        )
        if response is not None:
            print(
                f"[i] Navigazione completata: HTTP {response.status} | {page.url}",
                file=sys.stderr,
            )

        page.wait_for_timeout(max(0.0, wait_seconds) * 1000)

        if not sniffer.first_entry:
            poll_step_ms = 1000
            remaining_ms = min(15_000, max(0, int(wait_seconds * 1000)))
            while remaining_ms > 0 and not sniffer.first_entry:
                page.wait_for_timeout(poll_step_ms)
                remaining_ms -= poll_step_ms

    except Exception as exc:
        navigation_error = exc
        print(f"[!] Avviso durante il caricamento: {exc}", file=sys.stderr)

    print(f"[DEBUG] URL finale: {page.url}", file=sys.stderr)

    first = sniffer.first_entry
    if not first:
        print("[-] Nessun manifest .m3u8/.mpd rilevato.", file=sys.stderr)
        try:
            debug_path = Path(debug_dir)
            debug_path.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            prefix = _safe_debug_filename(f"stream_{stream_id}_{stamp}")
            page.screenshot(path=str(debug_path / f"{prefix}.png"), full_page=True)
            (debug_path / f"{prefix}.html").write_text(page.content(), encoding="utf-8")
        except Exception:
            pass
        browser.close()
        sys.exit(1)

    target_url = first["url"]
    headers = first.get("request_headers", {})
    clean_headers = {k: v for k, v in headers.items() if not k.startswith(":")}

    print(f"[✔] Manifest intercettato: {target_url}", file=sys.stderr)

    conf_folder = Path(conf_dir)
    conf_folder.mkdir(parents=True, exist_ok=True)
    out_folder = Path(out_dir)
    out_folder.mkdir(parents=True, exist_ok=True)

    conf_content = generate_stream_conf(stream_id, url, target_url, clean_headers)
    conf_path = conf_folder / f"stream_{stream_id}.conf"
    conf_path.write_text(conf_content, encoding="utf-8")
    print(f"[✔] Configurazione Nginx salvata in: {conf_path.resolve()}", file=sys.stderr)

    index_path = out_folder / "index.html"
    index_path.write_text(INDEX_HTML_TEMPLATE, encoding="utf-8")

    update_streams_json(out_folder, stream_id)
    browser.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Sniffer HLS per Nginx Proxy Live.")
    parser.add_argument("url", nargs="?", default=None, help="URL della pagina da monitorare")
    parser.add_argument("--url", dest="url_opt", help="URL della pagina")
    parser.add_argument("--stream-id", "-i", default="1", help="ID numerico o stringa dello stream (default: 1)")
    parser.add_argument("--conf-dir", type=str, default="/etc/nginx/conf.d", help="Cartella configurazioni Nginx")
    parser.add_argument("--out-dir", type=str, default="/var/www/hls", help="Cartella Web Player")
    parser.add_argument("--headed", action="store_true", help="Esegui browser visibile")
    parser.add_argument("--wait", type=float, default=6.0, help="Secondi di attesa")
    parser.add_argument("--debug-dir", type=str, default="/tmp/sniffer-vod-debug", help="Directory per screenshot/HTML")
    
    args = parser.parse_args()
    target_url = args.url or args.url_opt

    if not target_url:
        parser.error("Specifica l'URL di origine.")

    with sync_playwright() as playwright:
        run(
            playwright,
            target_url,
            stream_id=str(args.stream_id),
            headless=not args.headed,
            wait_seconds=args.wait,
            conf_dir=args.conf_dir,
            out_dir=args.out_dir,
            debug_dir=args.debug_dir,
        )


if __name__ == "__main__":
    main()

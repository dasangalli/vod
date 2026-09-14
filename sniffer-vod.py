#!/usr/bin/env python3
"""
sniffer-vod.py — HLS Manifest Sniffer & Nginx Stream Generator con supporto Proxy Residenziale
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
    """Intercetta la prima richiesta di manifest media (.m3u8 o .mpd) nella pagina."""

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
    parsed_url = urlparse(m3u8_url)
    cdn_host = parsed_url.netloc
    scheme = parsed_url.scheme or "https"
    
    path_parts = parsed_url.path.rsplit('/', 1)
    hls_path = path_parts[0] + '/' if len(path_parts) > 1 else '/'

    base_hls_url = f"{scheme}://{cdn_host}{hls_path}"

    referer = req_headers.get("referer", f"{scheme}://{urlparse(target_url).netloc}/")
    origin = req_headers.get("origin", f"{scheme}://{urlparse(target_url).netloc}")
    user_agent = req_headers.get("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
    accept = req_headers.get("accept", "*/*")
    accept_lang = req_headers.get("accept-language", "en-US,en;q=0.9")
    cookie_str = req_headers.get("cookie", "")
    sec_dest = req_headers.get("sec-fetch-dest", "empty")
    sec_mode = req_headers.get("sec-fetch-mode", "cors")
    sec_site = req_headers.get("sec-fetch-site", "same-site")

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    return f"""# =============================================================================
#  stream_{stream_id}.conf - GENERATO AUTOMATICAMENTE (PROXY RESIDENZIALE)
#  Stream ID:      {stream_id}
#  Data:           {timestamp}
#  Sorgente:       {target_url}
#  Manifest URL:   {m3u8_url}
# =============================================================================

# Proxy Playlist M3U8
location = /live/{stream_id}/playlist.m3u8 {{
    sub_filter_once off;
    sub_filter_types application/vnd.apple.mpegurl application/x-mpegurl text/plain;
    sub_filter "{base_hls_url}" "/live/{stream_id}/segment/";
    sub_filter "https://{cdn_host}/" "/live/{stream_id}/segment/";
    sub_filter "http://{cdn_host}/" "/live/{stream_id}/segment/";

    proxy_set_header Referer         "{referer}";
    proxy_set_header Origin          "{origin}";
    proxy_set_header User-Agent      "{user_agent}";
    proxy_set_header Accept          "{accept}";
    proxy_set_header Accept-Language "{accept_lang}";
    proxy_set_header Sec-Fetch-Dest  "{sec_dest}";
    proxy_set_header Sec-Fetch-Mode  "{sec_mode}";
    proxy_set_header Sec-Fetch-Site  "{sec_site}";
    proxy_set_header Cookie          "{cookie_str}";

    proxy_pass        {m3u8_url};
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

# Proxy Segmenti TS/AAC
location /live/{stream_id}/segment/ {{
    rewrite ^/live/{stream_id}/segment/(.*)$ {hls_path}$1 break;

    proxy_set_header Referer         "{referer}";
    proxy_set_header Origin          "{origin}";
    proxy_set_header User-Agent      "{user_agent}";
    proxy_set_header Accept          "{accept}";
    proxy_set_header Accept-Language "{accept_lang}";
    proxy_set_header Sec-Fetch-Dest  "{sec_dest}";
    proxy_set_header Sec-Fetch-Mode  "{sec_mode}";
    proxy_set_header Sec-Fetch-Site  "{sec_site}";
    proxy_set_header Cookie          "{cookie_str}";

    proxy_pass        {scheme}://{cdn_host};
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

INDEX_HTML_TEMPLATE = """<!DOCTYPE html>
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
        .container { width: 100%; max-width: 960px; text-align: center; }
        .controls-bar {
            background-color: #1e1e1e;
            border: 1px solid #3a3a3a;
            border-radius: 8px;
            padding: 12px 20px;
            margin-bottom: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .control-group { display: flex; align-items: center; gap: 8px; }
        .control-group label { font-size: 0.85rem; color: #aaa; text-transform: uppercase; }
        select {
            background-color: #2a2a2a; color: #ffffff; border: 1px solid #444;
            border-radius: 6px; padding: 8px 12px; font-size: 0.9rem; min-width: 220px;
        }
        video {
            width: 100%; height: auto; border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5); background-color: #000;
        }
        .info { margin-top: 15px; font-size: 0.9rem; color: #aaa; word-break: break-all; }
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
    <div class="info">
        <p>Sorgente HLS: <code id="current-url-display">...</code></p>
    </div>
</div>
<script>
    const video = document.getElementById('video');
    const streamSelect = document.getElementById('stream-select');
    const currentUrlDisplay = document.getElementById('current-url-display');
    let hls = null;

    async function initPlayer() {
        const urlParams = new URLSearchParams(window.location.search);
        const streamIdParam = urlParams.get('stream');
        let streams = [];
        try {
            const res = await fetch('streams.json?t=' + Date.now());
            if (res.ok) streams = await res.json();
        } catch (e) {}

        streamSelect.innerHTML = '';
        streams.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.url;
            opt.textContent = s.name;
            streamSelect.appendChild(opt);
        });

        let targetUrl = streamIdParam ? `/live/${streamIdParam}/playlist.m3u8` : (streams[0]?.url || '/live/1/playlist.m3u8');
        streamSelect.value = targetUrl;
        loadStream(targetUrl);
    }

    function loadStream(videoSrc) {
        currentUrlDisplay.textContent = videoSrc;
        if (hls) { hls.destroy(); hls = null; }
        if (Hls.isSupported()) {
            hls = new Hls({ debug: false, enableWorker: true, lowLatencyMode: true });
            hls.loadSource(videoSrc);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = videoSrc;
            video.addEventListener('loadedmetadata', () => video.play());
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

    streams = [s for s in streams if str(s.get("id")) != str(stream_id)]
    streams.append({"id": stream_id, "name": f"Canale {stream_id}", "url": f"/live/{stream_id}/playlist.m3u8"})
    streams.sort(key=lambda x: int(x["id"]) if str(x["id"]).isdigit() else str(x["id"]))

    json_path.write_text(json.dumps(streams, indent=2, ensure_ascii=False), encoding="utf-8")


def run(playwright: Playwright, url: str, stream_id: str, proxy_server: str | None, headless: bool, wait_seconds: float, conf_dir: str, out_dir: str) -> None:
    launch_args = {"headless": headless}
    if proxy_server:
        launch_args["proxy"] = {"server": proxy_server}
        print(f"[i] Configurazione proxy residenziale attiva: {proxy_server}", file=sys.stderr)

    browser = playwright.chromium.launch(**launch_args)
    context = browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    )
    page = context.new_page()

    sniffer = ManifestSniffer()
    page.on("request", sniffer.on_request)
    page.on("response", sniffer.on_response)

    print(f"[i] Navigazione verso la pagina target con proxy: {url} ...", file=sys.stderr)
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        
        # Gestisce eventuali iframe incorporati simulando il click per avviare il player
        try:
            for frame in page.frames:
                if "embed" in frame.url or "player" in frame.url:
                    frame.click("body", timeout=5000)
                    break
        except Exception:
            pass

        page.wait_for_timeout(wait_seconds * 1000)
    except Exception as exc:
        print(f"[!] Errore durante la navigazione: {exc}", file=sys.stderr)

    first = sniffer.first_entry
    if not first:
        print("[-] Nessun manifest .m3u8 / .mpd rilevato.", file=sys.stderr)
        browser.close()
        sys.exit(1)

    target_url = first["url"]
    headers = first.get("request_headers", {})
    clean_headers = {k: v for k, v in headers.items() if not k.startswith(":")}

    print(f"[✔] Manifest intercettato: {target_url}", file=sys.stderr)

    conf_path_dir = Path(conf_dir)
    out_path_dir = Path(out_dir)
    conf_path_dir.mkdir(parents=True, exist_ok=True)
    out_path_dir.mkdir(parents=True, exist_ok=True)

    # 1. Scrive la configurazione Nginx
    conf_content = generate_stream_conf(stream_id, url, target_url, clean_headers)
    conf_file = conf_path_dir / f"stream_{stream_id}.conf"
    conf_file.write_text(conf_content, encoding="utf-8")
    print(f"[✔] Configurazione Nginx salvata in: {conf_file.resolve()}", file=sys.stderr)

    # 2. Aggiorna i file statici web (index.html e streams.json)
    index_file = out_path_dir / "index.html"
    index_file.write_text(INDEX_HTML_TEMPLATE, encoding="utf-8")
    update_streams_json(out_path_dir, stream_id)
    print(f"[✔] File web statici aggiornati in: {out_path_dir.resolve()}", file=sys.stderr)

    browser.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Sniffer .m3u8 HLS con supporto Proxy Residenziale.")
    parser.add_argument("url", help="URL della pagina di streaming")
    parser.add_argument("--stream-id", "-i", default="1", help="ID dello stream")
    parser.add_argument("--proxy", default=None, help="Indirizzo del server proxy (es. http://85.235.150.219:3128)")
    parser.add_argument("--conf-dir", default="/etc/nginx/conf.d", help="Directory di output per Nginx conf")
    parser.add_argument("--out-dir", default="/var/www/hls", help="Directory di output per i file web")
    parser.add_argument("--headed", action="store_true", help="Mostra la finestra del browser")
    parser.add_argument("--wait", type=float, default=8.0, help="Secondi di attesa per l'intercettazione")

    args = parser.parse_args()

    with sync_playwright() as playwright:
        run(
            playwright,
            url=args.url,
            stream_id=str(args.stream_id),
            proxy_server=args.proxy,
            headless=not args.headed,
            wait_seconds=args.wait,
            conf_dir=args.conf_dir,
            out_dir=args.out_dir,
        )


if __name__ == "__main__":
    main()

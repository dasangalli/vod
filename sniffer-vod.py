#!/usr/bin/env python3
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
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
        self.first_entry = {
            "url": request.url,
            "method": request.method,
            "resource_type": request.resource_type,
            "seen_at": datetime.now(timezone.utc).isoformat(),
            "request_headers": {k: v for k, v in request.all_headers().items() if not k.startswith(":")},
            "status": response.status if response else 200,
        }

def generate_stream_conf(stream_id: str, target_url: str) -> str:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    worker_url = "https://vod-proxy-worker.mondochar.workers.dev"

    return f"""# =============================================================================
#  stream_{stream_id}.conf - LOCATION INTEGRATA
#  Stream ID:      {stream_id}
#  Data:           {timestamp}
#  Manifest URL:   {target_url}
# =============================================================================

location = /live/{stream_id}/playlist.m3u8 {{
    resolver 8.8.8.8 valid=30s ipv6=off;
    set $worker_url "{worker_url}";

    proxy_set_header x-target-url "{target_url}";
    proxy_pass $worker_url;
    proxy_ssl_server_name on;

    sub_filter_once off;
    sub_filter_types application/vnd.apple.mpegurl application/x-mpegurl text/plain;
    sub_filter "https://vixsrc.to/playlist/" "/live/{stream_id}/segment/";
    sub_filter "https://vixsrc.to/" "/live/{stream_id}/segment/";

    proxy_hide_header Access-Control-Allow-Origin;
    add_header Access-Control-Allow-Origin * always;
    add_header Cache-Control "no-cache, no-store, must-revalidate" always;
}}

location ~ ^/live/{stream_id}/segment/(.+)$ {{
    resolver 8.8.8.8 valid=30s ipv6=off;
    set $worker_url "{worker_url}";
    set $segment_target "https://vixsrc.to/playlist/$1";

    proxy_set_header x-target-url $segment_target;
    proxy_pass $worker_url;
    proxy_ssl_server_name on;

    proxy_hide_header Access-Control-Allow-Origin;
    add_header Access-Control-Allow-Origin * always;
    add_header Cache-Control "max-age=600" always;
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
        body { background: #121212; color: #fff; font-family: sans-serif; text-align: center; margin: 0; padding: 20px; }
        h2 { margin-top: 20px; }
        .container { max-width: 900px; margin: 0 auto; }
        video { width: 100%; max-width: 800px; background: #000; border-radius: 8px; margin-top: 15px; }
        .selector { margin: 20px 0; }
        select { padding: 8px 12px; background: #222; color: #fff; border: 1px solid #444; border-radius: 4px; font-size: 16px; }
        #source-info { font-size: 12px; color: #888; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <h2>HLS Live Web Player</h2>
        <div class="selector">
            <label for="streamSelect">STREAM ATTIVO: </label>
            <select id="streamSelect"></select>
        </div>
        <video id="video" controls autoplay></video>
        <div id="source-info">Sorgente HLS: <span id="srcPath">--</span></div>
    </div>

    <script>
        let hls = null;

        async function loadStreams() {
            try {
                // CORRETTO: Uso del percorso assoluto /streams.json per evitare errori di contesto
                const response = await fetch('/streams.json');
                const streams = await response.json();
                
                const select = document.getElementById('streamSelect');
                select.innerHTML = '';
                
                const urlParams = new URLSearchParams(window.location.search);
                let activeStreamId = urlParams.get('stream') || (streams.length > 0 ? streams[0].id : '1');

                streams.forEach(s => {
                    const option = document.createElement('option');
                    option.value = s.id;
                    option.textContent = s.name || `Canale ${s.id}`;
                    if (String(s.id) === String(activeStreamId)) {
                        option.selected = true;
                    }
                    select.appendChild(option);
                });

                select.addEventListener('change', (e) => {
                    const newId = e.target.value;
                    window.location.search = `?stream=${newId}`;
                });

                initPlayer(activeStreamId);
            } catch (err) {
                console.error("Errore caricamento streams.json:", err);
                const urlParams = new URLSearchParams(window.location.search);
                const activeStreamId = urlParams.get('stream') || '1';
                initPlayer(activeStreamId);
            }
        }

        function initPlayer(streamId) {
            const videoSrc = `/live/${streamId}/playlist.m3u8`;
            document.getElementById('srcPath').innerText = videoSrc;
            console.log("Avvio riproduzione sorgente:", videoSrc);

            const video = document.getElementById('video');
            if (Hls.isSupported()) {
                if (hls) {
                    hls.destroy();
                }
                hls = new Hls();
                hls.loadSource(videoSrc);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    video.play().catch(e => console.log("Autoplay bloccato:", e));
                });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = videoSrc;
                video.addEventListener('loadedmetadata', () => {
                    video.play().catch(e => console.log("Autoplay bloccato:", e));
                });
            }
        }

        loadStreams();
    </script>
</body>
</html>
"""

def run(playwright: Playwright, url: str, stream_id: str, proxy_server: str, conf_dir: str, out_dir: str) -> None:
    print(f"[i] Avvio Playwright con proxy: {proxy_server}...", file=sys.stderr)
    
    browser = playwright.chromium.launch(
        headless=True,
        proxy={"server": proxy_server},
        args=["--disable-blink-features=AutomationControlled", "--no-sandbox"]
    )

    context = browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        viewport={"width": 1920, "height": 1080}
    )

    page = context.new_page()
    sniffer = ManifestSniffer()
    page.on("request", sniffer.on_request)
    page.on("response", sniffer.on_response)

    try:
        page.goto(url, wait_until="domcontentloaded", timeout=40_000)
        page.wait_for_timeout(8000)
    except Exception as exc:
        print(f"[!] Errore navigazione: {exc}", file=sys.stderr)

    if not sniffer.first_entry:
        print("[-] Nessun manifest intercettato.", file=sys.stderr)
        browser.close()
        sys.exit(1)

    target_url = sniffer.first_entry["url"]
    print(f"[✔] Manifest intercettato: {target_url}", file=sys.stderr)

    Path(conf_dir).mkdir(parents=True, exist_ok=True)
    Path(out_dir).mkdir(parents=True, exist_ok=True)

    Path(conf_dir, f"stream_{stream_id}.conf").write_text(generate_stream_conf(stream_id, target_url), encoding="utf-8")
    Path(out_dir, "index.html").write_text(INDEX_HTML_TEMPLATE, encoding="utf-8")
    
    json_path = Path(out_dir, "streams.json")
    json_path.write_text(json.dumps([{"id": stream_id, "name": f"Canale {stream_id}", "url": f"/live/{stream_id}/playlist.m3u8"}], indent=2), encoding="utf-8")

    browser.close()

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url", help="URL di streaming")
    parser.add_argument("--stream-id", "-i", default="1")
    parser.add_argument("--proxy", required=True, help="Indirizzo proxy (es. socks4://ip:porta)")
    parser.add_argument("--conf-dir", default="./conf.d")
    parser.add_argument("--out-dir", default="./www")
    args = parser.parse_args()

    with sync_playwright() as playwright:
        run(playwright, args.url, args.stream_id, args.proxy, args.proxy and args.proxy, args.conf_dir, args.out_dir) if '--proxy' in sys.argv else run(playwright, args.url, args.stream_id, args.proxy, args.conf_dir, args.out_dir)

if __name__ == "__main__":
    main()

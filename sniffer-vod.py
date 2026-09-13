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
    <title>HLS Player Dinamico</title>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
</head>
<body style="background:#121212; color:#fff; text-align:center; padding-top:50px;">
    <h2>HLS Player - Stream ID: <span id="sid">1</span></h2>
    <video id="video" controls autoplay style="width:80%; max-width:800px;"></video>
    <script>
        // Estrae l'ID dello stream dalla query string (es. ?stream=1) o dal percorso
        const urlParams = new URLSearchParams(window.location.search);
        let streamId = urlParams.get('stream') || '1';
        
        const pathMatch = window.location.search.match(/stream=([0-9]+)/) || window.location.pathname.match(/stream[=/]([0-9]+)/);
        if (pathMatch) {
            streamId = pathMatch[1];
        }

        document.getElementById('sid').innerText = streamId;
        const videoSrc = `/live/${streamId}/playlist.m3u8`;
        console.log("Avvio riproduzione sorgente:", videoSrc);

        const video = document.getElementById('video');
        if (Hls.isSupported()) {
            const hls = new Hls();
            hls.loadSource(videoSrc);
            hls.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = videoSrc;
        }
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
        run(playwright, args.url, args.stream_id, args.proxy, args.conf_dir, args.out_dir)

if __name__ == "__main__":
    main()

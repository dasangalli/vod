import { Ionicons } from '@expo/vector-icons';
import { useKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Dimensions,
  LayoutChangeEvent,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useTVEventHandler,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------
const BASE_URL = 'http://129.153.47.200:8081';
const { width } = Dimensions.get('window');
const isTV = Platform.isTV || width >= 1280;

const WATCHDOG_INTERVAL_MS = 1000;
const STALL_THRESHOLD_MS   = 12000;
const RELOAD_COOLDOWN_MS   = 20000;
const RETRY_DELAYS         = [5000, 10000, 20000, 30000];
const CONTROLS_HIDE_DELAY  = 4000;

export default function PlayerScreen() {
  useKeepAwake();

  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistUrl = `${BASE_URL}/live/${id}/playlist.m3u8`;

  const webviewRef = useRef<WebView>(null);

  // Stati UI
  const [buffering, setBuffering]         = useState(true);
  const [error, setError]                 = useState(false);
  const [retryCount, setRetryCount]       = useState(0);
  const [showControls, setShowControls]   = useState(true);
  const [isPlaying, setIsPlaying]         = useState(true);
  const [isEnded, setIsEnded]             = useState(false);
  const [currentTime, setCurrentTime]     = useState(0);
  const [duration, setDuration]           = useState(0);
  const [progressBarWidth, setProgressBarWidth] = useState(0);

  // Modal Audio & Sottotitoli
  const [showTracksModal, setShowTracksModal] = useState(false);
  const [audioTracks, setAudioTracks]         = useState<any[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<number | null>(null);
  const [subTracks, setSubTracks]             = useState<any[]>([]);
  const [selectedSubId, setSelectedSubId]     = useState<number | null>(null);

  // Feedback Seek (+10s / -10s)
  const [seekFeedbackText, setSeekFeedbackText] = useState<string | null>(null);

  // Ref per Watchdog
  const lastTimeRef      = useRef<number>(0);
  const lastProgressRef  = useRef<number>(Date.now());
  const lastReloadRef    = useRef<number>(0);
  const bufferingRef     = useRef<boolean>(true);
  const errorRef         = useRef<boolean>(false);
  const isEndedRef       = useRef<boolean>(false);
  const retryCountRef    = useRef<number>(0);

  // Ref Timer
  const watchdogRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  // -------------------------------------------------------------------------
  // 1. Gestione Auto-Hide Controlli
  // -------------------------------------------------------------------------
  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      if (!showTracksModal && !isEndedRef.current) {
        setShowControls(false);
      }
    }, CONTROLS_HIDE_DELAY);
  }, [showTracksModal]);

  // Timer iniziale all'avvio della schermata
  useEffect(() => {
    resetControlsTimer();
  }, [resetControlsTimer]);

  // -------------------------------------------------------------------------
  // 2. Event Handler Telecomando TV (Android TV / Fire TV)
  // -------------------------------------------------------------------------
  useTVEventHandler((evt) => {
    if (!evt || !evt.eventType) return;

    // Qualsiasi pressione di un tasto sul telecomando fa mostrare i comandi e azzera il timer
    if (!showControls) {
      setShowControls(true);
      resetControlsTimer();
    } else {
      resetControlsTimer();
    }

    // Gestione diretta tasti fisici Media (Play / Pause / FastForward / Rewind)
    if (evt.eventType === 'playPause' || evt.eventType === 'select') {
      if (!showControls) {
        setShowControls(true);
        resetControlsTimer();
      }
    } else if (evt.eventType === 'fastForward') {
      seekBy(10);
    } else if (evt.eventType === 'rewind') {
      seekBy(-10);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Orientamento & Tasto Back Hardware
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!isTV) ScreenOrientation.unlockAsync();
    return () => {
      if (!isTV) ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    };
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showTracksModal) {
        setShowTracksModal(false);
        return true;
      }
      router.back();
      return true;
    });
    return () => sub.remove();
  }, [showTracksModal]);

  // -------------------------------------------------------------------------
  // 4. Comunicazione JS: Ricezione Eventi da HLS.js (WebView)
  // -------------------------------------------------------------------------
  const handleWebViewMessage = (eventData: string) => {
    try {
      const msg = JSON.parse(eventData);

      switch (msg.type) {
        case 'STATUS':
          if (msg.status === 'readyToPlay') {
            bufferingRef.current = false;
            errorRef.current = false;
            setBuffering(false);
            setError(false);
            lastProgressRef.current = Date.now();
            retryCountRef.current = 0;
            resetControlsTimer();
          } else if (msg.status === 'loading') {
            if (!isEndedRef.current) {
              bufferingRef.current = true;
              setBuffering(true);
            }
          } else if (msg.status === 'error') {
            errorRef.current = true;
            setError(true);
            setBuffering(false);
            scheduleRetry();
          }
          break;

        case 'TIME_UPDATE':
          setCurrentTime(msg.currentTime || 0);
          if (msg.duration) setDuration(msg.duration);
          setIsPlaying(!msg.paused);

          if (!msg.paused && msg.currentTime > 0 && bufferingRef.current) {
            bufferingRef.current = false;
            setBuffering(false);
          }
          break;

        case 'PLAYING_CHANGE':
          setIsPlaying(msg.isPlaying);
          if (msg.isPlaying) {
            bufferingRef.current = false;
            setBuffering(false);
            isEndedRef.current = false;
            setIsEnded(false);
            resetControlsTimer(); // Fai partire il timer di 4s appena il video riproduce
          }
          break;

        case 'ENDED':
          isEndedRef.current = true;
          setIsEnded(true);
          setIsPlaying(false);
          bufferingRef.current = false;
          setBuffering(false);
          setShowControls(true);
          break;

        case 'AUDIO_TRACKS':
          setAudioTracks(msg.tracks || []);
          if (msg.current !== undefined && msg.current !== null) {
            setSelectedAudioId(msg.current);
          }
          break;

        case 'AUDIO_SWITCHED':
          setSelectedAudioId(msg.id);
          break;

        case 'SUBTITLE_TRACKS':
          setSubTracks(msg.tracks || []);
          if (msg.current !== undefined && msg.current !== null) {
            setSelectedSubId(msg.current);
          }
          break;

        case 'SUBTITLE_SWITCHED':
          setSelectedSubId(msg.id);
          break;

        default:
          break;
      }
    } catch (e) {
      console.log('Errore parsing messaggio WebView:', e);
    }
  };

  // -------------------------------------------------------------------------
  // 5. Comandi inviati alla WebView
  // -------------------------------------------------------------------------
  const runJS = (code: string) => {
    webviewRef.current?.injectJavaScript(`${code}; true;`);
  };

  const togglePlay = () => {
    resetControlsTimer();
    if (isEnded) {
      isEndedRef.current = false;
      setIsEnded(false);
      runJS(`window.seekTo(0)`);
    }
    runJS('window.togglePlay()');
  };

  const seekBy = (seconds: number) => {
    isEndedRef.current = false;
    setIsEnded(false);
    runJS(`window.seekBy(${seconds})`);

    const sign = seconds > 0 ? '+' : '';
    setSeekFeedbackText(`${sign}${seconds}s`);
    if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
    seekTimerRef.current = setTimeout(() => setSeekFeedbackText(null), 800);

    resetControlsTimer();
  };

  const handleTimelinePress = (event: any) => {
    if (duration <= 0 || progressBarWidth <= 0) return;

    const touchX = event.nativeEvent.locationX;
    const ratio = Math.max(0, Math.min(1, touchX / progressBarWidth));
    const targetTime = ratio * duration;

    isEndedRef.current = false;
    setIsEnded(false);
    runJS(`window.seekTo(${targetTime})`);
    resetControlsTimer();
  };

  const selectAudioTrack = (index: number) => {
    runJS(`window.setAudioTrack(${index})`);
    setSelectedAudioId(index);
  };

  const selectSubtitleTrack = (index: number) => {
    runJS(`window.setSubtitleTrack(${index})`);
    setSelectedSubId(index);
  };

  const toggleControls = () => {
    if (showControls) {
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
      setShowControls(false);
    } else {
      setShowControls(true);
      resetControlsTimer();
    }
  };

  // -------------------------------------------------------------------------
  // 6. Watchdog e Auto-Retry
  // -------------------------------------------------------------------------
  const forceReload = () => {
    errorRef.current = false;
    bufferingRef.current = true;
    isEndedRef.current = false;
    setIsEnded(false);
    setError(false);
    setBuffering(true);
    lastProgressRef.current = Date.now();
    lastTimeRef.current = 0;
    runJS(`window.loadStream("${playlistUrl}")`);
  };

  const scheduleRetry = () => {
    if (retryRef.current) clearTimeout(retryRef.current);
    const count = retryCountRef.current;
    const delay = RETRY_DELAYS[Math.min(count, RETRY_DELAYS.length - 1)];
    retryCountRef.current += 1;
    setRetryCount(retryCountRef.current);

    retryRef.current = setTimeout(() => forceReload(), delay);
  };

  useEffect(() => {
    watchdogRef.current = setInterval(() => {
      if (errorRef.current || !isPlaying || isEndedRef.current) return;
      if (duration > 0 && currentTime >= duration - 1.5) return;

      const now = Date.now();
      if (currentTime !== lastTimeRef.current) {
        lastTimeRef.current = currentTime;
        lastProgressRef.current = now;
        if (bufferingRef.current) {
          bufferingRef.current = false;
          setBuffering(false);
        }
        return;
      }

      const elapsed = now - lastProgressRef.current;
      if (elapsed > STALL_THRESHOLD_MS) {
        if (now - lastReloadRef.current < RELOAD_COOLDOWN_MS) return;
        lastReloadRef.current = now;
        forceReload();
      }
    }, WATCHDOG_INTERVAL_MS);

    return () => {
      if (watchdogRef.current) clearInterval(watchdogRef.current);
      if (retryRef.current) clearTimeout(retryRef.current);
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
      stopSeeking();
    };
  }, [currentTime, isPlaying, duration]);

  // -------------------------------------------------------------------------
  // 7. Gestione Pressione Prolungata Avanzamento
  // -------------------------------------------------------------------------
  const startSeeking = (seconds: number) => {
    seekBy(seconds);
    holdTimerRef.current = setTimeout(() => {
      seekIntervalRef.current = setInterval(() => {
        seekBy(seconds);
      }, 250);
    }, 400);
  };

  const stopSeeking = () => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (seekIntervalRef.current) clearInterval(seekIntervalRef.current);
    holdTimerRef.current = null;
    seekIntervalRef.current = null;
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // -------------------------------------------------------------------------
  // 8. Codice HTML5 + hls.js
  // -------------------------------------------------------------------------
  const htmlContent = `
    <!DOCTYPE html>
    <html lang="it">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; background-color: #000; }
        html, body { width: 100%; height: 100%; overflow: hidden; background-color: #000; }
        video { width: 100%; height: 100%; object-fit: contain; background-color: #000; }
      </style>
    </head>
    <body>
      <video id="video" playsinline autoplay crossorigin="anonymous"></video>
      <script>
        const video = document.getElementById('video');
        let hls = null;

        function postRN(data) {
          if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(JSON.stringify(data));
          }
        }

        function loadStream(url) {
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

            hls.loadSource(url);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, function() {
              video.play().catch(() => {});
              postRN({ type: 'STATUS', status: 'readyToPlay' });
            });

            hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, function(event, data) {
              const tracks = data.audioTracks.map((t, i) => ({
                id: i,
                label: t.name || t.lang || ('Audio ' + (i + 1)),
                lang: t.lang
              }));
              postRN({ type: 'AUDIO_TRACKS', tracks: tracks, current: hls.audioTrack });
            });

            hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, function(event, data) {
              postRN({ type: 'AUDIO_SWITCHED', id: data.id });
            });

            hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, function(event, data) {
              const tracks = data.subtitleTracks.map((t, i) => ({
                id: i,
                label: t.name || t.lang || ('Sottotitolo ' + (i + 1)),
                lang: t.lang
              }));
              postRN({ type: 'SUBTITLE_TRACKS', tracks: tracks, current: hls.subtitleTrack });
            });

            hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, function(event, data) {
              postRN({ type: 'SUBTITLE_SWITCHED', id: data.id });
            });

            hls.on(Hls.Events.ERROR, function(event, data) {
              if (data.fatal) {
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                  hls.startLoad();
                } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                  hls.recoverMediaError();
                } else {
                  postRN({ type: 'STATUS', status: 'error' });
                }
              }
            });

          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
            video.addEventListener('loadedmetadata', function() {
              video.play();
              postRN({ type: 'STATUS', status: 'readyToPlay' });
            });
          }
        }

        video.addEventListener('timeupdate', function() {
          postRN({
            type: 'TIME_UPDATE',
            currentTime: video.currentTime,
            duration: video.duration || 0,
            paused: video.paused
          });
        });

        video.addEventListener('playing', function() {
          postRN({ type: 'STATUS', status: 'readyToPlay' });
          postRN({ type: 'PLAYING_CHANGE', isPlaying: true });
        });

        video.addEventListener('pause', function() {
          postRN({ type: 'PLAYING_CHANGE', isPlaying: false });
        });

        video.addEventListener('waiting', function() {
          postRN({ type: 'STATUS', status: 'loading' });
        });

        video.addEventListener('ended', function() {
          postRN({ type: 'ENDED' });
        });

        window.togglePlay = function() {
          if (video.paused) video.play();
          else video.pause();
        };

        window.seekBy = function(seconds) {
          video.currentTime = Math.max(0, video.currentTime + seconds);
        };

        window.seekTo = function(seconds) {
          video.currentTime = seconds;
        };

        window.setAudioTrack = function(index) {
          if (hls) hls.audioTrack = parseInt(index, 10);
        };

        window.setSubtitleTrack = function(index) {
          if (hls) hls.subtitleTrack = parseInt(index, 10);
        };

        loadStream("${playlistUrl}");
      </script>
    </body>
    </html>
  `;

  // -------------------------------------------------------------------------
  // 9. Render UI
  // -------------------------------------------------------------------------
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* WebView con focusable={false} per NON rubare i comandi al telecomando TV */}
      <WebView
        ref={webviewRef}
        originWhitelist={['*']}
        source={{ html: htmlContent, baseUrl: BASE_URL }}
        style={styles.video}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        mixedContentMode="always"
        focusable={false}
        onMessage={(e) => handleWebViewMessage(e.nativeEvent.data)}
      />

      {/* Overlay invisibile per catturare i clic quando i comandi sono nascosti */}
      {!showControls && (
        <Pressable
          style={StyleSheet.absoluteFillObject}
          onPress={toggleControls}
          focusable={true}
        />
      )}

      {/* Feedback temporaneo avanzamento (+10s / -10s) */}
      {seekFeedbackText && (
        <View style={styles.seekFeedbackOverlay} pointerEvents="none">
          <Text style={styles.seekFeedbackText}>{seekFeedbackText}</Text>
        </View>
      )}

      {/* Overlay Controlli Stile Netflix */}
      {showControls && (
        <Pressable style={styles.controlsContainer} onPress={toggleControls}>
          {/* Top Bar */}
          <View style={styles.topBar}>
            <Pressable
              focusable={true}
              onFocus={resetControlsTimer}
              onPress={(e) => {
                e.stopPropagation();
                router.back();
              }}
              style={({ focused }) => [styles.iconBtn, focused && styles.btnFocused]}
            >
              <Ionicons name="arrow-back" size={24} color="#fff" />
            </Pressable>
            <Text style={styles.channelTitle}>CANALE {id}</Text>
          </View>

          {/* Bottom Bar Controls */}
          <View style={styles.bottomBar}>
            {/* Timeline Progress Interattiva */}
            <View style={styles.timelineRow}>
              <Text style={styles.timeText}>{formatTime(currentTime)}</Text>

              <Pressable
                focusable={true}
                onFocus={resetControlsTimer}
                style={styles.progressBarTouchArea}
                onPress={(e) => {
                  e.stopPropagation();
                  handleTimelinePress(e);
                }}
                onLayout={(e: LayoutChangeEvent) => setProgressBarWidth(e.nativeEvent.layout.width)}
              >
                <View style={styles.progressBarBackground}>
                  <View
                    style={[
                      styles.progressBarFill,
                      { width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` },
                    ]}
                  />
                  {duration > 0 && (
                    <View
                      style={[
                        styles.progressThumb,
                        { left: `${(currentTime / duration) * 100}%` },
                      ]}
                    />
                  )}
                </View>
              </Pressable>

              <Text style={styles.timeText}>{formatTime(duration)}</Text>
            </View>

            {/* Action Buttons */}
            <View style={styles.buttonsRow}>
              <View style={styles.leftButtons}>
                {/* Indietro -10s */}
                <Pressable
                  focusable={true}
                  onFocus={resetControlsTimer}
                  onPressIn={(e) => {
                    e.stopPropagation();
                    startSeeking(-10);
                  }}
                  onPressOut={stopSeeking}
                  style={({ focused }) => [styles.iconBtn, focused && styles.btnFocused]}
                >
                  <Ionicons name="play-back" size={26} color="#fff" />
                </Pressable>

                {/* Play / Pausa / Replay (FOCUS PREFERITO PER TV) */}
                <Pressable
                  focusable={true}
                  hasTVPreferredFocus={true}
                  onFocus={resetControlsTimer}
                  onPress={(e) => {
                    e.stopPropagation();
                    togglePlay();
                  }}
                  style={({ focused }) => [styles.iconBtn, styles.playBtn, focused && styles.btnFocused]}
                >
                  <Ionicons
                    name={isEnded ? 'refresh' : isPlaying ? 'pause' : 'play'}
                    size={32}
                    color="#000"
                  />
                </Pressable>

                {/* Avanti +10s */}
                <Pressable
                  focusable={true}
                  onFocus={resetControlsTimer}
                  onPressIn={(e) => {
                    e.stopPropagation();
                    startSeeking(10);
                  }}
                  onPressOut={stopSeeking}
                  style={({ focused }) => [styles.iconBtn, focused && styles.btnFocused]}
                >
                  <Ionicons name="play-forward" size={26} color="#fff" />
                </Pressable>
              </View>

              {/* Menu Audio & Sottotitoli */}
              <Pressable
                focusable={true}
                onFocus={resetControlsTimer}
                onPress={(e) => {
                  e.stopPropagation();
                  setShowTracksModal(true);
                }}
                style={({ focused }) => [styles.iconBtn, focused && styles.btnFocused]}
              >
                <Ionicons name="options-outline" size={26} color="#fff" />
              </Pressable>
            </View>
          </View>
        </Pressable>
      )}

      {/* Modal Selezione Audio & Sottotitoli */}
      <Modal
        visible={showTracksModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowTracksModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Audio e Sottotitoli</Text>
              <Pressable
                focusable={true}
                hasTVPreferredFocus={true}
                onPress={() => setShowTracksModal(false)}
                style={({ focused }) => [styles.closeBtn, focused && styles.btnFocused]}
              >
                <Ionicons name="close" size={24} color="#fff" />
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.columnsContainer}>
              {/* Colonna Audio */}
              <View style={styles.column}>
                <Text style={styles.columnHeader}>AUDIO</Text>
                {audioTracks.length === 0 ? (
                  <Text style={styles.emptyTrackText}>Traccia audio predefinita</Text>
                ) : (
                  audioTracks.map((track) => {
                    const isSelected = selectedAudioId === track.id;
                    return (
                      <Pressable
                        key={track.id}
                        focusable={true}
                        onPress={() => selectAudioTrack(track.id)}
                        style={({ focused }) => [
                          styles.trackOption,
                          isSelected && styles.trackOptionSelected,
                          focused && styles.btnFocused,
                        ]}
                      >
                        <Text style={[styles.trackText, isSelected && styles.trackTextSelected]}>
                          {track.label}
                        </Text>
                        {isSelected && <Ionicons name="checkmark" size={18} color="#e8ff47" />}
                      </Pressable>
                    );
                  })
                )}
              </View>

              {/* Colonna Sottotitoli */}
              <View style={styles.column}>
                <Text style={styles.columnHeader}>SOTTOTITOLI</Text>
                <Pressable
                  focusable={true}
                  onPress={() => selectSubtitleTrack(-1)}
                  style={({ focused }) => [
                    styles.trackOption,
                    (selectedSubId === -1 || selectedSubId === null) && styles.trackOptionSelected,
                    focused && styles.btnFocused,
                  ]}
                >
                  <Text
                    style={[
                      styles.trackText,
                      (selectedSubId === -1 || selectedSubId === null) && styles.trackTextSelected,
                    ]}
                  >
                    Disattivati
                  </Text>
                  {(selectedSubId === -1 || selectedSubId === null) && (
                    <Ionicons name="checkmark" size={18} color="#e8ff47" />
                  )}
                </Pressable>

                {subTracks.map((track) => {
                  const isSelected = selectedSubId === track.id;
                  return (
                    <Pressable
                      key={track.id}
                      focusable={true}
                      onPress={() => selectSubtitleTrack(track.id)}
                      style={({ focused }) => [
                        styles.trackOption,
                        isSelected && styles.trackOptionSelected,
                        focused && styles.btnFocused,
                      ]}
                    >
                      <Text style={[styles.trackText, isSelected && styles.trackTextSelected]}>
                        {track.label}
                      </Text>
                      {isSelected && <Ionicons name="checkmark" size={18} color="#e8ff47" />}
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Overlay Caricamento / Watchdog */}
      {buffering && !error && !isEnded && (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator color="#e8ff47" size="large" />
          <Text style={styles.overlayText}>ripristino segnale…</Text>
        </View>
      )}

      {/* Overlay Errore Fatale */}
      {error && (
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.overlayTextError}>✕</Text>
          <Text style={styles.overlayText}>
            segnale assente — ricollegamento {retryCount}…
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  video: { ...StyleSheet.absoluteFillObject },

  // Control Overlay
  controlsContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'space-between',
    padding: 24,
    zIndex: 10,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  channelTitle: {
    color: '#fff',
    fontSize: 16,
    fontFamily: 'monospace',
    fontWeight: 'bold',
  },
  bottomBar: {
    gap: 16,
  },

  // Seek Progress Timeline
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  timeText: {
    color: '#ccc',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  progressBarTouchArea: {
    flex: 1,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  progressBarBackground: {
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 3,
    justifyContent: 'center',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#e8ff47',
    borderRadius: 3,
  },
  progressThumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#e8ff47',
    marginLeft: -7,
  },

  // Buttons & Focus (D-Pad / Remote)
  buttonsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  leftButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  iconBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  playBtn: {
    backgroundColor: '#e8ff47',
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  btnFocused: {
    borderColor: '#e8ff47',
    backgroundColor: 'rgba(232, 255, 71, 0.35)',
    transform: [{ scale: 1.15 }],
  },

  // Overlay Feedback Seek (+10s / -10s)
  seekFeedbackOverlay: {
    position: 'absolute',
    top: '45%',
    left: '35%',
    right: '35%',
    backgroundColor: 'rgba(0,0,0,0.85)',
    paddingVertical: 12,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
    borderWidth: 1,
    borderColor: '#e8ff47',
  },
  seekFeedbackText: {
    color: '#e8ff47',
    fontSize: 22,
    fontFamily: 'monospace',
    fontWeight: 'bold',
  },

  // Modal Audio & Sottotitoli
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    width: '100%',
    maxWidth: 650,
    maxHeight: '80%',
    backgroundColor: '#0a0a0a',
    borderWidth: 1,
    borderColor: '#222',
    borderRadius: 12,
    padding: 20,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#222',
    paddingBottom: 12,
    marginBottom: 16,
  },
  modalTitle: {
    color: '#fff',
    fontSize: 18,
    fontFamily: 'monospace',
    fontWeight: 'bold',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  columnsContainer: {
    flexDirection: 'row',
    gap: 20,
  },
  column: {
    flex: 1,
    gap: 8,
  },
  columnHeader: {
    color: '#666',
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: 'bold',
    marginBottom: 6,
  },
  trackOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#111',
    padding: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#222',
  },
  trackOptionSelected: {
    borderColor: '#e8ff47',
    backgroundColor: '#181e00',
  },
  trackText: {
    color: '#888',
    fontSize: 13,
    fontFamily: 'monospace',
  },
  trackTextSelected: {
    color: '#e8ff47',
    fontWeight: 'bold',
  },
  emptyTrackText: {
    color: '#666',
    fontSize: 12,
    fontFamily: 'monospace',
  },

  // Watchdog & Status Overlays
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    zIndex: 30,
  },
  overlayText: { color: '#888', fontFamily: 'monospace', fontSize: 13 },
  overlayTextError: { color: '#ff3b3b', fontSize: 32 },
});

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
  View,
  useTVEventHandler,
} from 'react-native';
import { WebView } from 'react-native-webview';

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------
const BASE_URL = 'http://129.153.47.200:8081';
const { width } = Dimensions.get('window');
const isTV = Platform.isTV || width >= 1280;

const CONTROLS_HIDE_DELAY = 4000;

export default function PlayerScreen() {
  useKeepAwake();

  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistUrl = `${BASE_URL}/live/${id}/playlist.m3u8`;

  const webviewRef = useRef<WebView>(null);

  // Stati UI
  const [buffering, setBuffering]               = useState(true);
  const [error, setError]                       = useState(false);
  const [showControls, setShowControls]         = useState(true);
  const [isPlaying, setIsPlaying]               = useState(true);
  const [isEnded, setIsEnded]                   = useState(false);
  const [currentTime, setCurrentTime]           = useState(0);
  const [duration, setDuration]                 = useState(0);
  const [progressBarWidth, setProgressBarWidth] = useState(0);
  const [isTimelineFocused, setIsTimelineFocused] = useState(false);

  // Ref di stato per event handler TV sincrono
  const showControlsRef       = useRef(showControls);
  const showTracksModalRef    = useRef(false);
  const isTimelineFocusedRef  = useRef(isTimelineFocused);

  useEffect(() => { showControlsRef.current = showControls; }, [showControls]);
  useEffect(() => { isTimelineFocusedRef.current = isTimelineFocused; }, [isTimelineFocused]);

  // Modal Audio & Sottotitoli
  const [showTracksModal, setShowTracksModal]   = useState(false);
  useEffect(() => {
    showTracksModalRef.current = showTracksModal;
  }, [showTracksModal]);

  const [audioTracks, setAudioTracks]         = useState<any[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<number | null>(null);
  const [subTracks, setSubTracks]             = useState<any[]>([]);
  const [selectedSubId, setSelectedSubId]     = useState<number | null>(null);

  // Feedback Seek (+10s / -10s)
  const [seekFeedbackText, setSeekFeedbackText] = useState<string | null>(null);

  // Ref per gestione stato sincrono
  const isEndedRef       = useRef<boolean>(false);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  // -------------------------------------------------------------------------
  // 1. Auto-Hide Controlli (4 secondi)
  // -------------------------------------------------------------------------
  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      if (!showTracksModalRef.current && !isEndedRef.current) {
        setShowControls(false);
      }
    }, CONTROLS_HIDE_DELAY);
  }, []);

  useEffect(() => {
    resetControlsTimer();
    return () => {
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    };
  }, [resetControlsTimer]);

  useEffect(() => {
    if (!showTracksModal) {
      resetControlsTimer();
    }
  }, [showTracksModal, resetControlsTimer]);

  // -------------------------------------------------------------------------
  // 2. Event Handler Nativo per Telecomando TV (D-Pad & Tasti Multimediali)
  // -------------------------------------------------------------------------
  if (typeof useTVEventHandler === 'function') {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useTVEventHandler((evt) => {
      if (!evt) return;
      const { eventType } = evt;

      // Se i controlli sono nascosti, qualsiasi tasto premuto li fa riapparire
      if (!showControlsRef.current) {
        if (['up', 'down', 'left', 'right', 'select', 'playPause'].includes(eventType)) {
          setShowControls(true);
          resetControlsTimer();
        }
        return;
      }

      // Se la modale lingue è aperta, lasciamo che il D-Pad navighi nel menu
      if (showTracksModalRef.current) return;

      resetControlsTimer();

      // Gestione frecce quando il focus è sulla barra del tempo
      if (isTimelineFocusedRef.current) {
        if (eventType === 'left') {
          seekBy(-10);
          return;
        }
        if (eventType === 'right') {
          seekBy(10);
          return;
        }
      }

      // Tasti multimediali fisici dedicati del telecomando (Rewind / FastForward / PlayPause)
      if (eventType === 'rewind') {
        seekBy(-10);
      } else if (eventType === 'fastForward') {
        seekBy(10);
      } else if (eventType === 'playPause') {
        togglePlay();
      }
    });
  }

  // -------------------------------------------------------------------------
  // 3. Orientamento & Gestione Tasto Back Hardware
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!isTV) {
      ScreenOrientation.unlockAsync().catch(() => {});
    }
    return () => {
      if (!isTV) {
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showTracksModal) {
        setShowTracksModal(false);
        return true;
      }
      if (showControls) {
        setShowControls(false);
        return true;
      }
      router.back();
      return true;
    });
    return () => sub.remove();
  }, [showTracksModal, showControls]);

  // -------------------------------------------------------------------------
  // 4. Ricezione Eventi da HLS.js (WebView)
  // -------------------------------------------------------------------------
  const handleWebViewMessage = (eventData: string) => {
    try {
      const msg = JSON.parse(eventData);

      switch (msg.type) {
        case 'STATUS':
          if (msg.status === 'readyToPlay') {
            setBuffering(false);
            setError(false);
            resetControlsTimer();
          } else if (msg.status === 'loading') {
            if (!isEndedRef.current) {
              setBuffering(true);
            }
          } else if (msg.status === 'error') {
            setError(true);
            setBuffering(false);
          }
          break;

        case 'TIME_UPDATE':
          setCurrentTime(msg.currentTime || 0);
          if (msg.duration) setDuration(msg.duration);
          setIsPlaying(!msg.paused);

          if (!msg.paused && msg.currentTime > 0) {
            setBuffering(false);
          }
          break;

        case 'PLAYING_CHANGE':
          setIsPlaying(msg.isPlaying);
          if (msg.isPlaying) {
            setBuffering(false);
            isEndedRef.current = false;
            setIsEnded(false);
            resetControlsTimer();
          }
          break;

        case 'ENDED':
          isEndedRef.current = true;
          setIsEnded(true);
          setIsPlaying(false);
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
  // 5. Comandi Player
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
    resetControlsTimer();
  };

  const selectSubtitleTrack = (index: number) => {
    runJS(`window.setSubtitleTrack(${index})`);
    setSelectedSubId(index);
    resetControlsTimer();
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
  // 6. HTML5 Player + HLS.js
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
  // 7. UI Render
  // -------------------------------------------------------------------------
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* WebView video isolata senza focus */}
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

      {/* Sfondo trasparente interattivo per mobile (Tap per aprire/chiudere) */}
      {showControls && (
        <Pressable
          style={StyleSheet.absoluteFillObject}
          onPress={toggleControls}
          focusable={false}
        />
      )}

      {/* Clic / Focus a comandi nascosti */}
      {!showControls && (
        <Pressable
          style={StyleSheet.absoluteFillObject}
          onPress={toggleControls}
          onFocus={resetControlsTimer}
          focusable={true}
          hasTVPreferredFocus={!showControls}
        />
      )}

      {/* Badge feedback +10s / -10s */}
      {seekFeedbackText && (
        <View style={styles.seekFeedbackOverlay} pointerEvents="none">
          <Text style={styles.seekFeedbackText}>{seekFeedbackText}</Text>
        </View>
      )}

      {/* Overlay Controlli TV (View trasparente non bloccante per D-Pad) */}
      {showControls && (
        <View style={styles.controlsContainer} pointerEvents="box-none">
          <View style={styles.topBar}>
            <Pressable
              focusable={true}
              onFocus={resetControlsTimer}
              onPress={() => router.back()}
              style={({ focused }) => [styles.iconBtn, focused && styles.btnFocused]}
            >
              <Ionicons name="arrow-back" size={24} color="#fff" />
            </Pressable>
            <Text style={styles.channelTitle}>CANALE {id}</Text>
          </View>

          <View style={styles.bottomBar}>
            <View style={styles.timelineRow}>
              <Text style={styles.timeText}>{formatTime(currentTime)}</Text>

              <Pressable
                focusable={true}
                onFocus={() => {
                  setIsTimelineFocused(true);
                  resetControlsTimer();
                }}
                onBlur={() => setIsTimelineFocused(false)}
                style={({ focused }) => [
                  styles.progressBarTouchArea,
                  focused && styles.timelineFocused,
                ]}
                onPress={(e) => handleTimelinePress(e)}
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

            <View style={styles.buttonsRow}>
              <View style={styles.leftButtons}>
                <Pressable
                  focusable={true}
                  onFocus={resetControlsTimer}
                  onPress={() => seekBy(-10)}
                  onPressIn={() => startSeeking(-10)}
                  onPressOut={stopSeeking}
                  style={({ focused }) => [styles.iconBtn, focused && styles.btnFocused]}
                >
                  <Ionicons name="play-back" size={26} color="#fff" />
                </Pressable>

                <Pressable
                  focusable={true}
                  hasTVPreferredFocus={showControls && !showTracksModal}
                  onFocus={resetControlsTimer}
                  onPress={togglePlay}
                  style={({ focused }) => [styles.iconBtn, styles.playBtn, focused && styles.btnFocused]}
                >
                  <Ionicons
                    name={isEnded ? 'refresh' : isPlaying ? 'pause' : 'play'}
                    size={32}
                    color="#000"
                  />
                </Pressable>

                <Pressable
                  focusable={true}
                  onFocus={resetControlsTimer}
                  onPress={() => seekBy(10)}
                  onPressIn={() => startSeeking(10)}
                  onPressOut={stopSeeking}
                  style={({ focused }) => [styles.iconBtn, focused && styles.btnFocused]}
                >
                  <Ionicons name="play-forward" size={26} color="#fff" />
                </Pressable>
              </View>

              <Pressable
                focusable={true}
                onFocus={resetControlsTimer}
                onPress={() => setShowTracksModal(true)}
                style={({ focused }) => [styles.iconBtn, focused && styles.btnFocused]}
              >
                <Ionicons name="options-outline" size={26} color="#fff" />
              </Pressable>
            </View>
          </View>
        </View>
      )}

      {/* Modal Audio/Sottotitoli */}
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
                hasTVPreferredFocus={showTracksModal}
                onPress={() => setShowTracksModal(false)}
                style={({ focused }) => [styles.closeBtn, focused && styles.btnFocused]}
              >
                <Ionicons name="close" size={24} color="#fff" />
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.columnsContainer}>
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

      {/* Buffering Overlay */}
      {buffering && !error && !isEnded && (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator color="#e8ff47" size="large" />
          <Text style={styles.overlayText}>caricamento in corso…</Text>
        </View>
      )}

      {/* Errore Overlay */}
      {error && (
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.overlayTextError}>✕</Text>
          <Text style={styles.overlayText}>impossibile caricare il contenuto</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1, backgroundColor: '#000' },

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
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  timelineFocused: {
    borderColor: '#e8ff47',
    backgroundColor: 'rgba(232, 255, 71, 0.15)',
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

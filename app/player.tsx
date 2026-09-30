import { Ionicons } from '@expo/vector-icons';
import { useKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Dimensions,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

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

  // Stati UI
  const [buffering, setBuffering]         = useState(true);
  const [error, setError]                 = useState(false);
  const [retryCount, setRetryCount]       = useState(0);
  const [showControls, setShowControls]   = useState(true);
  const [sourceKey, setSourceKey]         = useState(0);
  const [isPlaying, setIsPlaying]         = useState(true);
  const [currentTime, setCurrentTime]     = useState(0);
  const [duration, setDuration]           = useState(0);

  // Modal Audio & Sottotitoli
  const [showTracksModal, setShowTracksModal] = useState(false);
  const [audioTracks, setAudioTracks]         = useState<any[]>([]);
  const [selectedAudio, setSelectedAudio]     = useState<any>(null);
  const [subTracks, setSubTracks]             = useState<any[]>([]);
  const [selectedSub, setSelectedSub]         = useState<any>(null);

  // Feedback Seek (+10s / -10s)
  const [seekFeedbackText, setSeekFeedbackText] = useState<string | null>(null);

  // Ref per logica persistente
  const lastTimeRef      = useRef<number>(0);
  const lastProgressRef  = useRef<number>(Date.now());
  const lastReloadRef    = useRef<number>(0);
  const bufferingRef     = useRef<boolean>(true);
  const errorRef         = useRef<boolean>(false);
  const retryCountRef    = useRef<number>(0);
  const sourceKeyRef     = useRef<number>(0);

  // Ref Timer
  const watchdogRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  // -------------------------------------------------------------------------
  // 1. Inizializzazione Player
  // -------------------------------------------------------------------------
  const player = useVideoPlayer({ uri: playlistUrl }, (p) => {
    p.play();
  });

  // -------------------------------------------------------------------------
  // 2. Orientamento e Tasto Back Hardware
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
  // 3. Sincronizzazione Tracce Audio e Sottotitoli
  // -------------------------------------------------------------------------
  const syncTracks = useCallback(() => {
    if (!player) return;
    try {
      const audios = player.availableAudioTracks || [];
      const subs = player.availableSubtitleTracks || [];

      setAudioTracks(audios);
      setSubTracks(subs);

      if (player.audioTrack) {
        setSelectedAudio(player.audioTrack);
      } else if (audios.length > 0) {
        setSelectedAudio(audios[0]);
      }

      setSelectedSub(player.subtitleTrack || null);
    } catch (e) {
      console.log('Errore sync tracce:', e);
    }
  }, [player]);

  // Nomi per le tracce con fallback
  const getAudioTrackLabel = (track: any, index: number) => {
    if (!track) return `Audio ${index + 1}`;
    return track.label || track.language || track.id || `Audio ${index + 1}`;
  };

  const getSubTrackLabel = (track: any, index: number) => {
    if (!track) return `Sottotitolo ${index + 1}`;
    return track.label || track.language || track.id || `Sottotitolo ${index + 1}`;
  };

  // -------------------------------------------------------------------------
  // 4. Listener di Stato Player
  // -------------------------------------------------------------------------
  useEffect(() => {
    const statusSub = player.addListener('statusChange', (status) => {
      if (status.status === 'readyToPlay') {
        bufferingRef.current = false;
        errorRef.current = false;
        setBuffering(false);
        setError(false);
        setIsPlaying(player.playing);
        lastProgressRef.current = Date.now();
        retryCountRef.current = 0;
        syncTracks();
      }
      if (status.status === 'loading') {
        bufferingRef.current = true;
        setBuffering(true);
      }
      if (status.status === 'error') {
        errorRef.current = true;
        setError(true);
        setBuffering(false);
        scheduleRetry();
      }
    });

    const timeSub = player.addListener('timeUpdate', (event) => {
      setCurrentTime(event.currentTime);
      if (player.duration) setDuration(player.duration);
      // Aggiorna le tracce se non ancora rilevate
      if (audioTracks.length === 0) syncTracks();
    });

    const playingSub = player.addListener('playingChange', (event) => {
      setIsPlaying(event.isPlaying);
    });

    return () => {
      statusSub.remove();
      timeSub.remove();
      playingSub.remove();
    };
  }, [player, syncTracks, audioTracks.length]);

  // -------------------------------------------------------------------------
  // 5. Watchdog e Auto-Retry
  // -------------------------------------------------------------------------
  const forceReload = () => {
    errorRef.current = false;
    bufferingRef.current = true;
    setError(false);
    setBuffering(true);
    lastProgressRef.current = Date.now();
    lastTimeRef.current = 0;
    sourceKeyRef.current += 1;
    setSourceKey(sourceKeyRef.current);
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
    player.replace({ uri: playlistUrl });
    player.play();
  }, [sourceKey]);

  useEffect(() => {
    watchdogRef.current = setInterval(() => {
      if (!player || errorRef.current || !player.playing) return;

      const cTime = player.currentTime;
      const now = Date.now();

      if (cTime !== lastTimeRef.current) {
        lastTimeRef.current = cTime;
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
  }, [player]);

  // -------------------------------------------------------------------------
  // 6. Gestione Controlli Visivi e Seek
  // -------------------------------------------------------------------------
  const showControlsTemporarily = () => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      if (!showTracksModal) setShowControls(false);
    }, CONTROLS_HIDE_DELAY);
  };

  const togglePlay = () => {
    showControlsTemporarily();
    if (player.playing) {
      player.pause();
      setIsPlaying(false);
    } else {
      player.play();
      setIsPlaying(true);
    }
  };

  const seekBy = (seconds: number) => {
    if (!player) return;
    const target = Math.max(0, player.currentTime + seconds);
    player.currentTime = target;

    const sign = seconds > 0 ? '+' : '';
    setSeekFeedbackText(`${sign}${seconds}s`);
    if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
    seekTimerRef.current = setTimeout(() => setSeekFeedbackText(null), 800);

    showControlsTemporarily();
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
  // 7. Render Interfaccia
  // -------------------------------------------------------------------------
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      <VideoView
        player={player}
        style={styles.video}
        contentFit="contain"
        nativeControls={false}
        allowsFullscreen={false}
      />

      {/* Overlay invisibile per intercettare il TAP a schermo quando i controlli sono nascosti */}
      {!showControls && (
        <Pressable
          style={StyleSheet.absoluteFillObject}
          onPress={showControlsTemporarily}
          focusable={true}
        />
      )}

      {/* Feedback temporaneo avanzamento/riavvolgimento (+10s / -10s) */}
      {seekFeedbackText && (
        <View style={styles.seekFeedbackOverlay} pointerEvents="none">
          <Text style={styles.seekFeedbackText}>{seekFeedbackText}</Text>
        </View>
      )}

      {/* Overlay Controlli Stile Netflix */}
      {showControls && (
        <Pressable style={styles.controlsContainer} onPress={showControlsTemporarily}>
          {/* Top Bar */}
          <View style={styles.topBar}>
            <Pressable
              focusable={true}
              onPress={() => router.back()}
              style={({ focused }) => [styles.iconBtn, focused && styles.btnFocused]}
            >
              <Ionicons name="arrow-back" size={24} color="#fff" />
            </Pressable>
            <Text style={styles.channelTitle}>CANALE {id}</Text>
          </View>

          {/* Bottom Bar Controls */}
          <View style={styles.bottomBar}>
            {/* Timeline Progress */}
            <View style={styles.timelineRow}>
              <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
              <View style={styles.progressBarBackground}>
                <View
                  style={[
                    styles.progressBarFill,
                    { width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` },
                  ]}
                />
              </View>
              <Text style={styles.timeText}>{formatTime(duration)}</Text>
            </View>

            {/* Action Buttons */}
            <View style={styles.buttonsRow}>
              <View style={styles.leftButtons}>
                {/* Indietro -10s */}
                <Pressable
                  focusable={true}
                  onPressIn={() => startSeeking(-10)}
                  onPressOut={stopSeeking}
                  style={({ focused }) => [styles.iconBtn, focused && styles.btnFocused]}
                >
                  <Ionicons name="play-back" size={26} color="#fff" />
                </Pressable>

                {/* Play / Pausa */}
                <Pressable
                  focusable={true}
                  onPress={togglePlay}
                  style={({ focused }) => [styles.iconBtn, styles.playBtn, focused && styles.btnFocused]}
                >
                  <Ionicons name={isPlaying ? 'pause' : 'play'} size={32} color="#000" />
                </Pressable>

                {/* Avanti +10s */}
                <Pressable
                  focusable={true}
                  onPressIn={() => startSeeking(10)}
                  onPressOut={stopSeeking}
                  style={({ focused }) => [styles.iconBtn, focused && styles.btnFocused]}
                >
                  <Ionicons name="play-forward" size={26} color="#fff" />
                </Pressable>
              </View>

              {/* Menu Audio & Sottotitoli */}
              <Pressable
                focusable={true}
                onPress={() => {
                  syncTracks();
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
                  audioTracks.map((track, idx) => {
                    const isSelected =
                      selectedAudio &&
                      (selectedAudio.id === track.id || selectedAudio === track);
                    return (
                      <Pressable
                        key={track.id || idx}
                        focusable={true}
                        onPress={() => {
                          player.audioTrack = track;
                          setSelectedAudio(track);
                        }}
                        style={({ focused }) => [
                          styles.trackOption,
                          isSelected && styles.trackOptionSelected,
                          focused && styles.btnFocused,
                        ]}
                      >
                        <Text style={[styles.trackText, isSelected && styles.trackTextSelected]}>
                          {getAudioTrackLabel(track, idx)}
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
                  onPress={() => {
                    player.subtitleTrack = null;
                    setSelectedSub(null);
                  }}
                  style={({ focused }) => [
                    styles.trackOption,
                    selectedSub === null && styles.trackOptionSelected,
                    focused && styles.btnFocused,
                  ]}
                >
                  <Text style={[styles.trackText, selectedSub === null && styles.trackTextSelected]}>
                    Disattivati
                  </Text>
                  {selectedSub === null && <Ionicons name="checkmark" size={18} color="#e8ff47" />}
                </Pressable>

                {subTracks.map((track, idx) => {
                  const isSelected =
                    selectedSub &&
                    (selectedSub.id === track.id || selectedSub === track);
                  return (
                    <Pressable
                      key={track.id || idx}
                      focusable={true}
                      onPress={() => {
                        player.subtitleTrack = track;
                        setSelectedSub(track);
                      }}
                      style={({ focused }) => [
                        styles.trackOption,
                        isSelected && styles.trackOptionSelected,
                        focused && styles.btnFocused,
                      ]}
                    >
                      <Text style={[styles.trackText, isSelected && styles.trackTextSelected]}>
                        {getSubTrackLabel(track, idx)}
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
      {buffering && !error && (
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
  progressBarBackground: {
    flex: 1,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#e8ff47',
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
    backgroundColor: 'rgba(232, 255, 71, 0.25)',
    transform: [{ scale: 1.1 }],
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

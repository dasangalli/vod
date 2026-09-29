import { router, useLocalSearchParams, Stack } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Dimensions,
  Platform,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  TouchableOpacity,
  View,
} from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useKeepAwake } from 'expo-keep-awake';
import { Ionicons } from '@expo/vector-icons';

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------
const BASE_URL = 'http://129.153.47.200:8081';
const { width } = Dimensions.get('window');
const isTV = Platform.isTV || (width >= 1280 && !('ontouchstart' in global));

const WATCHDOG_INTERVAL_MS = 1000;  // Controlla lo stato ogni secondo
const STALL_THRESHOLD_MS   = 12000; // raised to 12s
const RELOAD_COOLDOWN_MS   = 20000; // Impedisce refresh a raffica (minimo 20s tra reload)
const RETRY_DELAYS         = [5000, 10000, 20000, 30000];
const CONTROLS_HIDE_DELAY  = 3000;

export default function PlayerScreen() {
  useKeepAwake();

  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistUrl = `${BASE_URL}/live/${id}/playlist.m3u8`;

  // Stati per la UI
  const [buffering, setBuffering]       = useState(true);
  const [error, setError]               = useState(false);
  const [retryCount, setRetryCount]     = useState(0);
  const [showControls, setShowControls] = useState(false);
  const [sourceKey, setSourceKey]       = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Riferimenti per la logica (persistenti tra i render)
  const lastTimeRef      = useRef<number>(0);
  const lastProgressRef  = useRef<number>(Date.now());
  const lastReloadRef    = useRef<number>(0);
  const bufferingRef     = useRef<boolean>(true);
  const errorRef         = useRef<boolean>(false);
  const retryCountRef    = useRef<number>(0);
  const sourceKeyRef     = useRef<number>(0);

  const watchdogRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (isFullscreen) {
        setIsFullscreen(false);
        return true;
      }
      router.back();
      return true;
    });
    return () => sub.remove();
  }, [isFullscreen]);

  // -------------------------------------------------------------------------
  // 3. Listener di Stato del Player
  // -------------------------------------------------------------------------
  useEffect(() => {
    const statusSub = player.addListener('statusChange', (status) => {
      if (status.status === 'readyToPlay') {
        bufferingRef.current = false;
        errorRef.current     = false;
        setBuffering(false);
        setError(false);
        lastProgressRef.current = Date.now();
        retryCountRef.current = 0; 
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

    return () => statusSub.remove();
  }, [player]);

  // -------------------------------------------------------------------------
  // 4. Logica di Reload e Retry
  // -------------------------------------------------------------------------
  const forceReload = () => {
    console.log('[Player] Eseguo Force Reload...');
    errorRef.current     = false;
    bufferingRef.current = true;
    setError(false);
    setBuffering(true);
    lastProgressRef.current = Date.now();
    lastTimeRef.current     = 0;
    sourceKeyRef.current    += 1;
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

  // Effetto che scatta al cambio della sourceKey (refresh fisico)
  useEffect(() => {
    player.replace({ uri: playlistUrl });
    player.play();
  }, [sourceKey]);

  // -------------------------------------------------------------------------
  // 5. Watchdog (Rilevamento Blocchi - 6 Secondi)
  // -------------------------------------------------------------------------
  useEffect(() => {
    watchdogRef.current = setInterval(() => {
      // Non intervenire se il player non esiste, se c'è già un errore o se è in pausa
      if (!player || errorRef.current || player.paused) return;

      const currentTime = player.currentTime;
      const now         = Date.now();

      // Caso 1: Il video scorre
      if (currentTime !== lastTimeRef.current) {
        lastTimeRef.current     = currentTime;
        lastProgressRef.current = now;
        if (bufferingRef.current) {
          bufferingRef.current = false;
          setBuffering(false);
        }
        return;
      }

      // Caso 2: Il video è fermo (currentTime identico al precedente)
      const elapsedSinceProgress = now - lastProgressRef.current;

      if (elapsedSinceProgress > STALL_THRESHOLD_MS) {
        // Verifica cooldown per evitare refresh infiniti
        if (now - lastReloadRef.current < RELOAD_COOLDOWN_MS) return;

        console.warn(`[Watchdog] Blocco di ${elapsedSinceProgress}ms. Forzo ripristino.`);
        lastReloadRef.current = now;
        forceReload();
      }
    }, WATCHDOG_INTERVAL_MS);

    return () => {
      if (watchdogRef.current)     clearInterval(watchdogRef.current);
      if (retryRef.current)         clearTimeout(retryRef.current);
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    };
  }, [player]);

  // -------------------------------------------------------------------------
  // 6. UI & Gestione Tap
  // -------------------------------------------------------------------------
  function handleTap() {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setShowControls(false), CONTROLS_HIDE_DELAY);
  }

  return (
    <TouchableWithoutFeedback onPress={handleTap}>
      <View style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />

        <VideoView
          player={player}
          style={styles.video}
          contentFit={isFullscreen ? 'cover' : 'contain'}
          nativeControls={false}
          allowsFullscreen={false}
        />

        {/* Overlay Controlli (Back e Fullscreen) */}
        {showControls && (
          <>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => isFullscreen ? setIsFullscreen(false) : router.back()}
            >
              <Ionicons name="arrow-back" size={24} color="#e8ff47" />
              <Text style={styles.backText}>INDIETRO</Text>
            </TouchableOpacity>

            {!isFullscreen && (
              <>
                <TouchableOpacity
                  style={styles.fullscreenButton}
                  onPress={() => setIsFullscreen(true)}
                >
                  <Ionicons name="expand" size={24} color="#e8ff47" />
                </TouchableOpacity>

                <View style={styles.hud}>
                  <Text style={styles.hudText}>CANALE: {id}</Text>
                </View>
              </>
            )}
          </>
        )}

        {/* Overlay Caricamento / Stallo */}
        {buffering && !error && (
          <View style={styles.overlay}>
            <ActivityIndicator color="#e8ff47" size="large" />
            <Text style={styles.overlayText}>ripristino segnale…</Text>
          </View>
        )}

        {/* Overlay Errore Fatale */}
        {error && (
          <View style={styles.overlay}>
            <Text style={styles.overlayTextError}>✕</Text>
            <Text style={styles.overlayText}>
              segnale assente — ricollegamento {retryCount}…
            </Text>
          </View>
        )}
      </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  video: { ...StyleSheet.absoluteFillObject },
  backButton: {
    position: 'absolute',
    top: 40,
    left: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    padding: 10,
    borderRadius: 20,
    zIndex: 10,
  },
  backText: { color: '#e8ff47', marginLeft: 8, fontWeight: 'bold', fontSize: 12 },
  fullscreenButton: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    padding: 10,
    borderRadius: 20,
    zIndex: 10,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  overlayText:      { color: '#888', fontFamily: 'monospace', fontSize: 13 },
  overlayTextError: { color: '#ff3b3b', fontSize: 32 },
  hud:              { position: 'absolute', bottom: 16, left: 20, opacity: 0.4 },
  hudText:          { color: '#c8c8c8', fontFamily: 'monospace', fontSize: 11 },
});

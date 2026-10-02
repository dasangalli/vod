import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  LayoutChangeEvent,
  Platform,
  TVEventHandler,
} from 'react-native';

interface VideoPlayerProps {
  sourceUrl: string;
  posterUrl?: string;
  title?: string;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  sourceUrl,
  posterUrl,
  title,
}) => {
  const videoRef = useRef<HTMLVideoElement | any>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isBuffering, setIsBuffering] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [progressBarWidth, setProgressBarWidth] = useState(0);
  const [isProgressBarFocused, setIsProgressBarFocused] = useState(false);

  const controlsTimeout = useRef<NodeJS.Timeout | null>(null);
  const fastSeekInterval = useRef<NodeJS.Timeout | null>(null);

  // Formatta i secondi in MM:SS o HH:MM:SS
  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || seconds < 0) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const pad = (num: number) => String(num).padStart(2, '0');

    if (h > 0) {
      return `${pad(h)}:${pad(m)}:${pad(s)}`;
    }
    return `${pad(m)}:${pad(s)}`;
  };

  // Resetta il timer di auto-nascondimento controlli
  const resetControlsTimer = () => {
    setShowControls(true);
    if (controlsTimeout.current) {
      clearTimeout(controlsTimeout.current);
    }
    controlsTimeout.current = setTimeout(() => {
      setShowControls(false);
    }, 3000);
  };

  useEffect(() => {
    resetControlsTimer();
    return () => {
      if (controlsTimeout.current) clearTimeout(controlsTimeout.current);
      if (fastSeekInterval.current) clearInterval(fastSeekInterval.current);
    };
  }, []);

  // Funzione per saltare avanti/indietro
  const seekBy = (seconds: number) => {
    if (videoRef.current) {
      const newTime = Math.min(
        Math.max(videoRef.current.currentTime + seconds, 0),
        duration || videoRef.current.duration || 0
      );
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    } else {
      setCurrentTime((prev) => Math.min(Math.max(prev + seconds, 0), duration));
    }
    resetControlsTimer();
  };

  // Inizio pressione prolungata (Long Press) per seek continuo
  const startContinuousSeek = (seconds: number) => {
    seekBy(seconds);
    if (fastSeekInterval.current) clearInterval(fastSeekInterval.current);
    fastSeekInterval.current = setInterval(() => {
      seekBy(seconds);
    }, 200);
  };

  // Fine pressione prolungata
  const stopContinuousSeek = () => {
    if (fastSeekInterval.current) {
      clearInterval(fastSeekInterval.current);
      fastSeekInterval.current = null;
    }
  };

  // Gestione tasti Freccia per la barra di avanzamento (Android TV, Apple TV, Smart TV Web e Tastiera)
  useEffect(() => {
    if (!isProgressBarFocused) return;

    // Listener per telecomandi TV Native (Android TV / Apple TV)
    let tvSubscription: any = null;
    try {
      if (typeof TVEventHandler !== 'undefined' && TVEventHandler) {
        if (typeof (TVEventHandler as any).addListener === 'function') {
          tvSubscription = (TVEventHandler as any).addListener((evt: any) => {
            if (!evt) return;
            const eventType = evt.eventType;
            if (eventType === 'right' || eventType === 'fastForward') {
              seekBy(10);
            } else if (eventType === 'left' || eventType === 'rewind') {
              seekBy(-10);
            }
          });
        }
      }
    } catch (e) {
      // Ignora se la piattaforma non supporta TVEventHandler
    }

    // Listener per Smart TV Web / Tastiera (Samsung Tizen, LG webOS, PC)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        seekBy(10);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seekBy(-10);
      }
    };

    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      if (tvSubscription && typeof tvSubscription.remove === 'function') {
        tvSubscription.remove();
      }
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('keydown', handleKeyDown);
      }
    };
  }, [isProgressBarFocused, currentTime, duration]);

  // Toggle Play / Pausa
  const togglePlay = () => {
    resetControlsTimer();
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    } else {
      videoRef.current.play();
      setIsPlaying(true);
    }
  };

  // Toggle Mute
  const toggleMute = () => {
    resetControlsTimer();
    if (!videoRef.current) return;
    videoRef.current.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  // Toggle Fullscreen
  const toggleFullscreen = () => {
    resetControlsTimer();
    if (!videoRef.current) return;
    if (!isFullscreen) {
      if (videoRef.current.requestFullscreen) {
        videoRef.current.requestFullscreen();
      } else if (videoRef.current.webkitRequestFullscreen) {
        videoRef.current.webkitRequestFullscreen();
      }
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
      setIsFullscreen(false);
    }
  };

  // Clic/Tocco sulla barra di avanzamento per saltare al punto prescelto (Mobile/Web)
  const handleTimelinePress = (e: any) => {
    resetControlsTimer();
    if (!duration || progressBarWidth <= 0) return;
    const locationX = e.nativeEvent.locationX;
    const percentage = Math.max(0, Math.min(1, locationX / progressBarWidth));
    const targetTime = percentage * duration;

    if (videoRef.current) {
      videoRef.current.currentTime = targetTime;
    }
    setCurrentTime(targetTime);
  };

  return (
    <Pressable style={styles.container} onPress={resetControlsTimer}>
      {/* Elemento Video Web */}
      {Platform.OS === 'web' && (
        <video
          ref={videoRef}
          src={sourceUrl}
          poster={posterUrl}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          onTimeUpdate={() => {
            if (videoRef.current) {
              setCurrentTime(videoRef.current.currentTime);
            }
          }}
          onLoadedMetadata={() => {
            if (videoRef.current) {
              setDuration(videoRef.current.duration);
              setIsBuffering(false);
            }
          }}
          onWaiting={() => setIsBuffering(true)}
          onPlaying={() => {
            setIsBuffering(false);
            setIsPlaying(true);
          }}
          onPause={() => setIsPlaying(false)}
          onEnded={() => {
            setIsPlaying(false);
            setShowControls(true);
          }}
        />
      )}

      {/* Indicatore di Buffering / Caricamento */}
      {isBuffering && (
        <View style={styles.loaderContainer}>
          <ActivityIndicator size="large" color="#E50914" />
        </View>
      )}

      {/* Sovrapposizione Controlli */}
      {showControls && (
        <View style={styles.controlsOverlay}>
          {/* Titolo in alto */}
          {title && (
            <View style={styles.header}>
              <Text style={styles.titleText}>{title}</Text>
            </View>
          )}

          {/* Pulsanti Centrali (-10s, Play/Pausa, +10s) */}
          <View style={styles.centerControls}>
            <Pressable
              focusable={true}
              onFocus={resetControlsTimer}
              style={({ focused }) => [
                styles.controlButton,
                focused && styles.focusedButton,
              ]}
              onPress={() => seekBy(-10)}
              onPressIn={() => startContinuousSeek(-10)}
              onPressOut={stopContinuousSeek}
            >
              <Text style={styles.buttonText}>-10s</Text>
            </Pressable>

            <Pressable
              focusable={true}
              onFocus={resetControlsTimer}
              style={({ focused }) => [
                styles.playPauseButton,
                focused && styles.focusedButton,
              ]}
              onPress={togglePlay}
            >
              <Text style={styles.playPauseText}>{isPlaying ? '❚❚' : '▶'}</Text>
            </Pressable>

            <Pressable
              focusable={true}
              onFocus={resetControlsTimer}
              style={({ focused }) => [
                styles.controlButton,
                focused && styles.focusedButton,
              ]}
              onPress={() => seekBy(10)}
              onPressIn={() => startContinuousSeek(10)}
              onPressOut={stopContinuousSeek}
            >
              <Text style={styles.buttonText}>+10s</Text>
            </Pressable>
          </View>

          {/* Barra di avanzamento e Controlli in Basso */}
          <View style={styles.bottomBar}>
            {/* Barra della Durata Touch e Focus TV */}
            <Pressable
              focusable={true}
              onFocus={() => {
                resetControlsTimer();
                setIsProgressBarFocused(true);
              }}
              onBlur={() => setIsProgressBarFocused(false)}
              style={[
                styles.progressBarTouchArea,
                isProgressBarFocused && styles.progressBarFocused,
              ]}
              onPress={(e) => {
                e.stopPropagation();
                handleTimelinePress(e);
              }}
              onLayout={(e: LayoutChangeEvent) =>
                setProgressBarWidth(e.nativeEvent.layout.width)
              }
            >
              <View style={styles.progressBarBackground}>
                <View
                  style={[
                    styles.progressBarFill,
                    {
                      width: `${
                        duration > 0 ? (currentTime / duration) * 100 : 0
                      }%`,
                    },
                  ]}
                />
                {duration > 0 && (
                  <View
                    style={[
                      styles.progressThumb,
                      { left: `${(currentTime / duration) * 100}%` },
                      isProgressBarFocused && styles.progressThumbFocused,
                    ]}
                  />
                )}
              </View>
            </Pressable>

            {/* Fila di controlli inferiori (Tempo, Mute, Schermo Intero) */}
            <View style={styles.bottomControlsRow}>
              <Text style={styles.timeText}>
                {formatTime(currentTime)} / {formatTime(duration)}
              </Text>

              <View style={styles.rightControls}>
                <Pressable
                  focusable={true}
                  onFocus={resetControlsTimer}
                  style={({ focused }) => [
                    styles.smallButton,
                    focused && styles.focusedButton,
                  ]}
                  onPress={toggleMute}
                >
                  <Text style={styles.buttonText}>
                    {isMuted ? '🔇' : '🔊'}
                  </Text>
                </Pressable>

                <Pressable
                  focusable={true}
                  onFocus={resetControlsTimer}
                  style={({ focused }) => [
                    styles.smallButton,
                    focused && styles.focusedButton,
                  ]}
                  onPress={toggleFullscreen}
                >
                  <Text style={styles.buttonText}>
                    {isFullscreen ? '⤦' : '⤢'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      )}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loaderContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  controlsOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'space-between',
    padding: 20,
  },
  header: {
    marginTop: 10,
  },
  titleText: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '600',
  },
  centerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 25,
    marginHorizontal: 15,
  },
  playPauseButton: {
    backgroundColor: '#E50914',
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playPauseText: {
    color: '#FFF',
    fontSize: 24,
    fontWeight: 'bold',
  },
  buttonText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '600',
  },
  focusedButton: {
    borderWidth: 2,
    borderColor: '#FFF',
    transform: [{ scale: 1.1 }],
  },
  bottomBar: {
    width: '100%',
    marginBottom: 10,
  },
  progressBarTouchArea: {
    height: 24,
    justifyContent: 'center',
    width: '100%',
    paddingVertical: 8,
  },
  progressBarFocused: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 4,
  },
  progressBarBackground: {
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 2,
    width: '100%',
    position: 'relative',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#E50914',
    borderRadius: 2,
  },
  progressThumb: {
    position: 'absolute',
    top: -4,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#E50914',
    marginLeft: -6,
  },
  progressThumbFocused: {
    width: 18,
    height: 18,
    borderRadius: 9,
    top: -7,
    marginLeft: -9,
    backgroundColor: '#FFF',
    borderWidth: 2,
    borderColor: '#E50914',
  },
  bottomControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  timeText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '500',
  },
  rightControls: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  smallButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    marginLeft: 10,
  },
});

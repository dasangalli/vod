import React from 'react';
import { StyleSheet, View, Text, SafeAreaView, StatusBar } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';

// Sostituisci con l'IP della tua VM e la porta corretta del flusso HLS
const STREAM_URL = 'http://129.153.47.200/live/1/playlist.m3u8';

export default function App() {
  // Inizializza il player nativo HLS
  const player = useVideoPlayer(STREAM_URL, player => {
    player.loop = false;
    player.play(); // Avvia la riproduzione automaticamente
  });

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#121212" />
      
      <View style={styles.header}>
        <Text style={styles.title}>Streaming Nativo HLS</Text>
      </View>
      
      <View style={styles.videoContainer}>
        <VideoView
          style={styles.video}
          player={player}
          allowsFullscreen={true}
          allowsPictureInPicture={true}
          nativeControls={true}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
    justifyContent: 'center',
  },
  header: {
    padding: 20,
    alignItems: 'center',
  },
  title: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: 'bold',
  },
  videoContainer: {
    width: '100%',
    aspectRatio: 16 / 9, // Mantiene le proporzioni video standard
    backgroundColor: '#000000',
  },
  video: {
    width: '100%',
    height: '100%',
  },
});

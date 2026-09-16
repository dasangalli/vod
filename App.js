import React from 'react';
import { StyleSheet, SafeAreaView, StatusBar, Linking } from 'react-native';
import { WebView } from 'react-native-webview';

export default function App() {
  const handleShouldStartLoad = (event) => {
    const { url } = event;
    
    // Permette solo i normali link web HTTP e HTTPS
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return true;
    }
    
    // Se il sito prova ad aprire app esterne (store, social, ecc.), prova a gestirle o le blocca
    try {
      Linking.canOpenURL(url).then((supported) => {
        if (supported) {
          Linking.openURL(url);
        }
      });
    } catch (e) {
      console.log('Impossibile aprire il link:', e);
    }
    
    // Impedisce alla WebView di caricare schemi sconosciuti facendo fallire la pagina
    return false;
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#121212" />
      <WebView 
        source={{ uri: 'http://129.153.47.200:8080' }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        originWhitelist={['http://*', 'https://*']}
        onShouldStartLoadWithRequest={handleShouldStartLoad}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
});

import React, { useRef, useEffect } from 'react';
import { StyleSheet, SafeAreaView, StatusBar, BackHandler, Linking } from 'react-native';
import { WebView } from 'react-native-webview';

export default function App() {
  const webViewRef = useRef(null);

  // Gestione del tasto "Indietro" su Android per navigare nella cronologia della WebView
  useEffect(() => {
    const backAction = () => {
      if (webViewRef.current) {
        // Torna indietro nella cronologia della WebView
        webViewRef.current.goBack();
        return true; // Evita la chiusura dell'app
      }
      return false;
    };

    const backHandler = BackHandler.addEventListener(
      'hardwareBackPress',
      backAction
    );

    return () => backHandler.remove();
  }, []);

  const handleShouldStartLoad = (event) => {
    const { url } = event;
    
    // Permetti il traffico HTTP/HTTPS principale
    if (url.startsWith('http://') || url.startsWith('https://')) {
      
      // FILTRO ANTI-PUBBLICITÀ / POPUP: 
      // Puoi bloccare domini di sponsor/adv noti se compaiono spesso
      const blockedKeywords = ['ads', 'popup', 'banner', 'track', 'analytic'];
      if (blockedKeywords.some(keyword => url.includes(keyword))) {
        console.log('Pubblicità bloccata:', url);
        return false;
      }

      return true;
    }
    
    // Gestione di schemi particolari (es. mailto, tel, ecc.)
    try {
      Linking.canOpenURL(url).then((supported) => {
        if (supported) {
          Linking.openURL(url);
        }
      });
    } catch (e) {
      console.log('Impossibile aprire il link:', e);
    }
    
    return false;
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#121212" />
      <WebView 
        ref={webViewRef}
        source={{ uri: 'http://129.153.47.200:8080' }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        setSupportMultipleWindows={false} // Fondamentale: apre i link con target="_blank" dentro la stessa WebView senza creare finestre pop-up
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

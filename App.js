import React, { useRef, useEffect } from 'react';
import { StyleSheet, SafeAreaView, StatusBar, BackHandler, Linking, View, TouchableOpacity, Text } from 'react-native';
import { WebView } from 'react-native-webview';

export default function App() {
  const webViewRef = useRef(null);

  // Gestione del tasto "Indietro" fisico su Android
  useEffect(() => {
    const backAction = () => {
      if (webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      return false;
    };

    const backHandler = BackHandler.addEventListener(
      'hardwareBackPress',
      backAction
    );

    return () => backHandler.remove();
  }, []);

  // Script iniettato nella WebView per bloccare pop-up, window.open e overlay trasparenti pubblicitari
  const injectedScript = `
    (function() {
      // 1. Neutralizza window.open per evitare aperture di finestre indesiderate
      window.open = function() { return null; };
      
      // 2. Forza i link con target="_blank" ad aprirsi nella stessa finestra
      document.addEventListener('click', function(e) {
        let target = e.target.closest('a');
        if (target && target.getAttribute('target') === '_blank') {
          target.setAttribute('target', '_self');
        }
      }, true);

      // 3. Rimuove automaticamente i div invisibili/overlay che coprono i player e bloccano i click
      setInterval(() => {
        const overlays = document.querySelectorAll('div[style*="z-index: 99999"], div[style*="z-index:999999"], div[style*="position: fixed"][style*="width: 100%"][style*="height: 100%"]');
        overlays.forEach(el => {
          // Rimuove l'overlay solo se è vuoto o non contiene il video player principale
          if (el.innerText.trim() === '' && !el.querySelector('video')) {
            el.remove();
          }
        });
      }, 1000);
    })();
    true;
  `;

  const handleShouldStartLoad = (event) => {
    const { url } = event;
    
    if (url.startsWith('http://') || url.startsWith('https://')) {
      // Filtro anti-pubblicità / domini di tracciamento e popunder aggressivi
      const blockedKeywords = ['ads', 'popup', 'banner', 'track', 'analytic', 'click', 'syndication', 'popunder', 'advert'];
      if (blockedKeywords.some(keyword => url.includes(keyword))) {
        console.log('Pubblicità bloccata:', url);
        return false;
      }

      return true;
    }
    
    // Gestione schemi particolari (mailto, tel, ecc.)
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
      
      {/* BARRA DI NAVIGAZIONE SUPERIORE (Risolve il problema del ritorno alla schermata precedente) */}
      <View style={styles.navBar}>
        <TouchableOpacity style={styles.navButton} onPress={() => webViewRef.current?.goBack()}>
          <Text style={styles.navButtonText}>◀ Indietro</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={() => webViewRef.current?.reload()}>
          <Text style={styles.navButtonText}>🔄 Ricarica</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={() => webViewRef.current?.injectJavaScript("window.location.href='http://129.153.47.200:8080';")}>
          <Text style={styles.navButtonText}>🏠 Home</Text>
        </TouchableOpacity>
      </View>

      <WebView 
        ref={webViewRef}
        source={{ uri: 'http://129.153.47.200:8080' }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowsInlineMediaPlayback={true}
        allowsFullscreenVideo={true} // FONDAMENTALE: permette l'uso corretto del Fullscreen nei player video
        mediaPlaybackRequiresUserAction={false}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false} // Impedisce agli script di aprire popup a tradimento
        injectedJavaScript={injectedScript}
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
  navBar: {
    height: 45,
    backgroundColor: '#1e1e1e',
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  navButton: {
    paddingVertical: 8,
    paddingHorizontal: 15,
  },
  navButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
});

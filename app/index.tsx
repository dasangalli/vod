import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useFocusEffect } from 'expo-router'; // Aggiunto useFocusEffect
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Keyboard,
} from 'react-native';

const BASE_URL    = 'http://129.153.47.200:8000';
const STORAGE_KEY = 'last_stream_id';

const { width } = Dimensions.get('window');
const isTV = Platform.isTV || width >= 1280;

export default function HomeScreen() {
  const [streamId, setStreamId] = useState('');
  const [error, setError]       = useState('');
  const [isInputFocused, setIsInputFocused] = useState(false);
  
  const inputRef  = useRef<TextInput>(null);
  const dotAnim   = useRef(new Animated.Value(1)).current;

  // 1. Animazione Logo (sempre attiva)
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(dotAnim, { toValue: 0.3, duration: 900, useNativeDriver: true }),
        Animated.timing(dotAnim, { toValue: 1,   duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [dotAnim]);

  // 2. RECUPERO DATI E FOCUS AUTOMATICO (Ogni volta che torni qui)
  useFocusEffect(
    useCallback(() => {
      // Recupera l'ultimo ID usato
      AsyncStorage.getItem(STORAGE_KEY).then(val => {
        if (val) setStreamId(val);
      });

      // Forza la comparsa della tastiera
      // Il timeout è CRUCIALE su Android TV per aspettare che la transizione finisca
      const timer = setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
        }
      }, 500);

      return () => clearTimeout(timer);
    }, [])
  );

  async function handleStart() {
    const id = streamId.trim();
    if (!id) {
      setError('inserisci id');
      inputRef.current?.focus();
      return;
    }
    setError('');
    Keyboard.dismiss();
    await AsyncStorage.setItem(STORAGE_KEY, id);
    router.push(`/player?id=${id}`);
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.card, isTV && styles.cardTV]}>

          <View style={styles.logoRow}>
            <Animated.View style={[styles.dot, { opacity: dotAnim }]} />
            <Text style={[styles.logo, isTV && styles.logoTV]}>SYSTEM CONSOLE v3.2</Text>
          </View>

          <Text style={styles.label}>selezione canale</Text>

          <TextInput
            ref={inputRef}
            style={[
              styles.input, 
              isTV && styles.inputTV,
              isInputFocused && styles.inputFocused
            ]}
            value={streamId}
            onChangeText={text => { setStreamId(text); setError(''); }}
            onSubmitEditing={handleStart}
            placeholder="0"
            placeholderTextColor="#222"
            
            // Configurazione tastiera TV
            keyboardType="numeric" 
            returnKeyType="done"
            
            onFocus={() => setIsInputFocused(true)}
            onBlur={() => setIsInputFocused(false)}
            
            blurOnSubmit={false}
            selectTextOnFocus
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            focusable={true}
            onPress={handleStart}
            style={({ focused, pressed }) => [
              styles.btn,
              isTV && styles.btnTV,
              focused && styles.btnFocused,
              pressed && styles.btnPressed,
            ]}
          >
            {({ focused }) => (
              <Text style={[
                styles.btnText, 
                isTV && styles.btnTextTV,
                focused && styles.btnTextFocused
              ]}>
                {focused ? "CONFERMA >" : "AVVIA STREAM"}
              </Text>
            )}
          </Pressable>

          <View style={styles.footer}>
            <Text style={styles.baseUrl}>{BASE_URL.replace('http://', '')}</Text>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050505' },
  scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 400, padding: 24, backgroundColor: '#0a0a0a', borderWidth: 1, borderColor: '#1a1a1a' },
  cardTV: { maxWidth: 550, padding: 40, borderWidth: 2 },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 30 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#e8ff47' },
  logo: { color: '#e8ff47', fontFamily: 'monospace', fontWeight: '700', fontSize: 12, letterSpacing: 2 },
  logoTV: { fontSize: 14 },
  label: { color: '#333', fontFamily: 'monospace', fontSize: 10, textTransform: 'uppercase', marginBottom: 10 },
  input: { backgroundColor: '#000', borderWidth: 1, borderColor: '#222', color: '#fff', fontFamily: 'monospace', fontSize: 32, padding: 15, textAlign: 'center', marginBottom: 10 },
  inputTV: { fontSize: 42, padding: 20 },
  inputFocused: { borderColor: '#e8ff47', backgroundColor: '#0d0d00' },
  error: { color: '#ff3b3b', fontFamily: 'monospace', fontSize: 12, textAlign: 'center', marginBottom: 15 },
  btn: { backgroundColor: '#111', borderWidth: 1, borderColor: '#222', padding: 16, alignItems: 'center', marginTop: 10 },
  btnTV: { padding: 20 },
  btnFocused: { backgroundColor: '#e8ff47', borderColor: '#fff', transform: [{ scale: 1.05 }] },
  btnPressed: { opacity: 0.7 },
  btnText: { color: '#666', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 14 },
  btnTextTV: { fontSize: 16 },
  btnTextFocused: { color: '#000' },
  footer: { marginTop: 30 },
  baseUrl: { color: '#222', fontFamily: 'monospace', fontSize: 9, textAlign: 'center' },
});

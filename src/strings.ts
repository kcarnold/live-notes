export type SupportedLocale = 'en' | 'fr' | 'ht' | 'es';
export const SUPPORTED_LOCALES: SupportedLocale[] = ['en', 'fr', 'ht', 'es'];

/** Maps internal language identifiers (from configAtoms.languages) to BCP 47 codes */
export const LANGUAGE_BCP47: Record<string, string> = {
  'French': 'fr',
  'Haitian Creole': 'ht',
  'Spanish': 'es',
};

export interface AppStrings {
  // Connection status
  connecting: string;
  disconnected: string;

  // Component headers
  translation: string;
  bilingual: string;

  // Home page
  chooseLayout: string;

  // Layout names
  layoutSlideAndTranslation: string;
  layoutBilingualView: string;
  layoutEverything: string;
  layoutSlideAndListen: string;

  // Font size controls
  decreaseFontSize: string;
  increaseFontSize: string;

  // TTS
  autoSpeak: string;
  tapToSpeak: string;
  disableAutoTTS: string;
  enableAutoTTS: string;
  ttsError: string;

  // Bilingual viewer
  noContent: string;
  notTranslated: string;

  // Slide viewer
  noSlides: string;
  waitingForProclaim: string;
  isProclaimRunning: string;
  previous: string;
  next: string;
  untitledPresentation: string;

  // Live audio translation (Gemini Live + LiveKit)
  listenLive: string;
  liveListening: string;
  waitingForSpeaker: string;
  waitingForSpeech: string;
  liveAudioError: string;
  retry: string;
  broadcast: string;
  startBroadcast: string;
  listeners: string;
  activeTranslations: string;
  noActiveTranslations: string;
  broadcastEditorOnly: string;
  listenOriginal: string;
  favorites: string;
  allLanguages: string;
  micLevel: string;

  // Navigation
  goHome: string;

  // Layout diagram component labels
  componentSourceText: string;
  componentTranslatedText: string;
  componentBilingual: string;
  componentCurrentSlide: string;
}

export const strings: Record<SupportedLocale, AppStrings> = {
  en: {
    connecting: 'Connecting...',
    disconnected: 'Disconnected',
    translation: 'Translation',
    bilingual: 'Bilingual',
    chooseLayout: 'Choose Layout',
    layoutSlideAndTranslation: 'Slide and Translation',
    layoutBilingualView: 'Bilingual View',
    layoutSlideAndListen: 'Slide and Listen',
    layoutEverything: 'Everything',
    decreaseFontSize: 'Decrease font size',
    increaseFontSize: 'Increase font size',
    autoSpeak: '⏸️ Auto-Speak',
    tapToSpeak: '▶️ Tap to Speak',
    disableAutoTTS: 'Disable auto text-to-speech',
    enableAutoTTS: 'Enable auto text-to-speech',
    ttsError: 'Error: ',
    noContent: 'No content yet',
    notTranslated: '(not translated)',
    listenLive: 'Listen live',
    liveListening: 'Listening live',
    waitingForSpeaker: 'Waiting for the speaker…',
    waitingForSpeech: 'Waiting for translated speech…',
    liveAudioError: 'Live audio unavailable',
    retry: 'Retry',
    broadcast: 'Broadcast',
    startBroadcast: 'Start broadcasting',
    listeners: 'listeners',
    activeTranslations: 'Active translations',
    noActiveTranslations: 'None yet — listeners can request them',
    broadcastEditorOnly: 'Broadcasting is available in editor mode (#editor).',
    listenOriginal: 'Original / English',
    favorites: 'Favorites',
    allLanguages: 'All languages',
    micLevel: 'Mic level',
    noSlides: 'No slides available',
    waitingForProclaim: 'Waiting for Proclaim data...',
    isProclaimRunning: 'Is the Proclaim service running?',
    previous: 'Previous',
    next: 'Next',
    untitledPresentation: 'Untitled Presentation',
    goHome: 'Go home',
    componentSourceText: 'Source Text',
    componentTranslatedText: 'Translated Text',
    componentBilingual: 'Bilingual View',
    componentCurrentSlide: 'Current Slide',
  },
  fr: {
    connecting: 'Connexion\u2026',
    disconnected: 'D\u00e9connect\u00e9',
    translation: 'Traduction',
    bilingual: 'Bilingue',
    chooseLayout: 'Choisir la mise en page',
    layoutSlideAndTranslation: 'Diapositive et traduction',
    layoutBilingualView: 'Vue bilingue',
    layoutSlideAndListen: 'Diapositive et écoute',
    layoutEverything: 'Tout',
    decreaseFontSize: 'Diminuer la taille du texte',
    increaseFontSize: 'Augmenter la taille du texte',
    autoSpeak: '\u23f8\ufe0f Parole auto',
    tapToSpeak: '\u25b6\ufe0f Appuyer pour parler',
    disableAutoTTS: 'D\u00e9sactiver la synth\u00e8se vocale automatique',
    enableAutoTTS: 'Activer la synth\u00e8se vocale automatique',
    ttsError: 'Erreur\u00a0: ',
    noContent: 'Aucun contenu pour l\u2019instant',
    notTranslated: '(non traduit)',
    listenLive: 'Écouter en direct',
    liveListening: 'Écoute en direct',
    waitingForSpeaker: 'En attente de l’orateur…',
    waitingForSpeech: 'En attente de la traduction vocale…',
    liveAudioError: 'Audio en direct indisponible',
    retry: 'Réessayer',
    broadcast: 'Diffusion',
    startBroadcast: 'Démarrer la diffusion',
    listeners: 'auditeurs',
    activeTranslations: 'Traductions actives',
    noActiveTranslations: 'Aucune pour l’instant— les auditeurs peuvent en demander',
    broadcastEditorOnly: 'La diffusion est disponible en mode éditeur (#editor).',
    listenOriginal: 'Original / Anglais',
    favorites: 'Favoris',
    allLanguages: 'Toutes les langues',
    micLevel: 'Niveau du micro',
    noSlides: 'Aucune diapositive disponible',
    waitingForProclaim: 'En attente des donn\u00e9es Proclaim\u2026',
    isProclaimRunning: 'Le service Proclaim est-il actif\u00a0?',
    previous: 'Pr\u00e9c\u00e9dent',
    next: 'Suivant',
    untitledPresentation: 'Pr\u00e9sentation sans titre',
    goHome: 'Accueil',
    componentSourceText: 'Texte source',
    componentTranslatedText: 'Texte traduit',
    componentBilingual: 'Vue bilingue',
    componentCurrentSlide: 'Diapositive actuelle',
  },
  es: {
    connecting: 'Conectando\u2026',
    disconnected: 'Desconectado',
    translation: 'Traducci\u00f3n',
    bilingual: 'Biling\u00fce',
    chooseLayout: 'Elegir dise\u00f1o',
    layoutSlideAndTranslation: 'Diapositiva y traducci\u00f3n',
    layoutBilingualView: 'Vista biling\u00fce',
    layoutSlideAndListen: 'Diapositiva y escucha',
    layoutEverything: 'Todo',
    decreaseFontSize: 'Disminuir tama\u00f1o de fuente',
    increaseFontSize: 'Aumentar tama\u00f1o de fuente',
    autoSpeak: '\u23f8\ufe0f Habla autom\u00e1tica',
    tapToSpeak: '\u25b6\ufe0f Toca para hablar',
    disableAutoTTS: 'Desactivar texto a voz autom\u00e1tico',
    enableAutoTTS: 'Activar texto a voz autom\u00e1tico',
    ttsError: 'Error: ',
    noContent: 'Sin contenido a\u00fan',
    notTranslated: '(no traducido)',
    listenLive: 'Escuchar en vivo',
    liveListening: 'Escuchando en vivo',
    waitingForSpeaker: 'Esperando al orador…',
    waitingForSpeech: 'Esperando la traducción hablada…',
    liveAudioError: 'Audio en vivo no disponible',
    retry: 'Reintentar',
    broadcast: 'Transmisión',
    startBroadcast: 'Iniciar transmisión',
    listeners: 'oyentes',
    activeTranslations: 'Traducciones activas',
    noActiveTranslations: 'Ninguna aún— los oyentes pueden solicitarlas',
    broadcastEditorOnly: 'La transmisión está disponible en modo editor (#editor).',
    listenOriginal: 'Original / Inglés',
    favorites: 'Favoritos',
    allLanguages: 'Todos los idiomas',
    micLevel: 'Nivel del micrófono',
    noSlides: 'No hay diapositivas disponibles',
    waitingForProclaim: 'Esperando datos de Proclaim\u2026',
    isProclaimRunning: '\u00bfEst\u00e1 ejecut\u00e1ndose el servicio Proclaim?',
    previous: 'Anterior',
    next: 'Siguiente',
    untitledPresentation: 'Presentaci\u00f3n sin t\u00edtulo',
    goHome: 'Ir al inicio',
    componentSourceText: 'Texto fuente',
    componentTranslatedText: 'Texto traducido',
    componentBilingual: 'Vista biling\u00fce',
    componentCurrentSlide: 'Diapositiva actual',
  },
  ht: {
    connecting: 'Koneksyon\u2026',
    disconnected: 'Dekonekte',
    translation: 'Tradiksyon',
    bilingual: 'Bileng',
    chooseLayout: 'Chwazi Dispozisyon',
    layoutSlideAndTranslation: 'Diapozitiv ak Tradiksyon',
    layoutBilingualView: 'Vi Bileng',
    layoutSlideAndListen: 'Diapozitiv ak \u00c9coute',
    layoutEverything: 'Tout bagay',
    decreaseFontSize: 'Diminye gw\u00f2s\u00e8 l\u00e8t',
    increaseFontSize: 'Ogmante gw\u00f2s\u00e8 l\u00e8t',
    autoSpeak: '\u23f8\ufe0f Pale otomatik',
    tapToSpeak: '\u25b6\ufe0f Peze pou pale',
    disableAutoTTS: 'Dezaktive t\u00e8ks-an-vwa otomatik',
    enableAutoTTS: 'Aktive t\u00e8ks-an-vwa otomatik',
    ttsError: 'Er\u00e8\u00a0: ',
    noContent: 'Pa gen kontni pou kounye a',
    notTranslated: '(pa tradui)',
    listenLive: 'Koute an dirèk',
    liveListening: 'Ap koute an dirèk',
    waitingForSpeaker: 'N ap tann moun k ap pale a…',
    waitingForSpeech: 'N ap tann tradiksyon vokal la…',
    liveAudioError: 'Odyo an dirèk pa disponib',
    retry: 'Reeseye',
    broadcast: 'Difizyon',
    startBroadcast: 'Kòmanse difizyon',
    listeners: 'moun k ap koute',
    activeTranslations: 'Tradiksyon aktif',
    noActiveTranslations: 'Pa gen okenn pou kounye a— moun k ap koute ka mande yo',
    broadcastEditorOnly: 'Difizyon disponib nan mòd editè (#editor).',
    listenOriginal: 'Orijinal / Angle',
    favorites: 'Favori',
    allLanguages: 'Tout lang yo',
    micLevel: 'Nivo mikwo',
    noSlides: 'Pa gen diapozitiv disponib',
    waitingForProclaim: 'Ap tann done Proclaim\u2026',
    isProclaimRunning: '\u00c8ske s\u00e8vis Proclaim la ap kouri?',
    previous: 'Anvan',
    next: 'Apr\u00e8',
    untitledPresentation: 'Prezantasyon San Tit',
    goHome: 'Retounen lakay',
    componentSourceText: 'Teks sous',
    componentTranslatedText: 'Teks tradui',
    componentBilingual: 'Vi Bileng',
    componentCurrentSlide: 'Diapozitiv aktyèl',
  },
};

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
  chooseLanguage: string;

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

  // Stick-to-bottom scrolling (BilingualBlockViewer, LiveTranscript)
  jumpToLatest: string;

  // Slide viewer
  noSlides: string;
  waitingForProclaim: string;
  isProclaimRunning: string;
  previous: string;
  next: string;
  untitledPresentation: string;

  // Live audio translation (Gemini Live + LiveKit)
  listenLive: string;
  stopAudio: string;
  englishTranscript: string;
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
  downloadSession: string;

  // Status / admin page (skeleton for #72)
  statusTitle: string;
  statusHealthTitle: string;
  statusHealthPlaceholder: string;
  statusNotReporting: string;
  statusCanaryTitle: string;
  statusCanaryPlaceholder: string;
  statusExportTitle: string;
  statusExportDescription: string;
  statusTranscriptsTitle: string;
  statusTranscriptsEmpty: string;
  statusTranscriptSource: string;
  statusTranscriptNoUpdates: string;

  // Layout diagram component labels
  componentSourceText: string;
  componentTranslatedText: string;
  componentBilingual: string;
  componentCurrentSlide: string;
  componentListen: string;

  // Slide translation review
  slideReviewTitle: string;
  slidesInputLabel: string;
  loadOnAirItem: string;
  suggestTranslations: string;
  suggesting: string;
  bibleLookupsLabel: string;
  bibleLookupFound: string;
  bibleLookupMissing: string;
  save: string;
  saveAll: string;
  saving: string;
  statusReviewed: string;
  statusUnsaved: string;
  reviewSourceHeader: string;
  noSlidesToReview: string;
  editorOnlyReview: string;
  reviewSlidesLink: string;
  unreviewedBadge: string;
  conversationHeader: string;
  noConversation: string;
  followUpPlaceholder: string;
  sendMessage: string;
  selectItemLabel: string;
  sourceChangedWarning: string;
  agentThinking: string;
}

export const strings: Record<SupportedLocale, AppStrings> = {
  en: {
    connecting: 'Connecting...',
    disconnected: 'Disconnected',
    translation: 'Translation',
    bilingual: 'Bilingual',
    chooseLayout: 'Choose Layout',
    chooseLanguage: 'Language',
    layoutSlideAndTranslation: 'Slide and Translation',
    layoutBilingualView: 'Bilingual View',
    layoutSlideAndListen: 'Slide and Listen',
      componentListen: 'Listen',
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
    jumpToLatest: '↓ New',
    listenLive: 'Listen live',
    stopAudio: 'Stop audio',
    englishTranscript: 'English transcript',
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
    downloadSession: 'Download session',
    statusTitle: 'Session status',
    statusHealthTitle: 'Component health',
    statusHealthPlaceholder: 'Live component heartbeats will appear here.',
    statusNotReporting: 'Not yet reporting',
    statusCanaryTitle: 'Preflight canary',
    statusCanaryPlaceholder: 'A pre-service end-to-end check will run here.',
    statusExportTitle: 'Session export',
    statusExportDescription:
      'Download this session’s notes, slide translations, and live transcripts as a single readable HTML file.',
    statusTranscriptsTitle: 'Live transcripts',
    statusTranscriptsEmpty: 'No live transcripts in this session yet.',
    statusTranscriptSource: 'source',
    statusTranscriptNoUpdates: 'No updates since page load',
    componentSourceText: 'Source Text',
    componentTranslatedText: 'Translated Text',
    componentBilingual: 'Bilingual View',
    componentCurrentSlide: 'Current Slide',
    slideReviewTitle: 'Slide Translation Review',
    slidesInputLabel: 'Item slides (separate slides with a blank line or --)',
    loadOnAirItem: 'Load on-air item',
    suggestTranslations: 'Suggest',
    suggesting: 'Suggesting…',
    bibleLookupsLabel: 'Bible lookups',
    bibleLookupFound: 'Found in',
    bibleLookupMissing: 'No canonical text found',
    save: 'Save',
    saveAll: 'Save all reviewed',
    saving: 'Saving…',
    statusReviewed: 'Reviewed',
    statusUnsaved: 'Unsaved',
    reviewSourceHeader: 'Source',
    noSlidesToReview: 'Enter or load an item to review its slides.',
    editorOnlyReview: 'Open this page with #editor to edit and save translations.',
    reviewSlidesLink: 'Review Slide Translations',
    unreviewedBadge: 'unreviewed',
    conversationHeader: 'Agent conversation',
    noConversation: 'No conversation yet — Suggest to start one.',
    followUpPlaceholder: 'Ask a question or give feedback…',
    sendMessage: 'Send',
    selectItemLabel: 'Service item',
    sourceChangedWarning: 'Source slides changed since this was translated.',
    agentThinking: 'Agent is working…',
  },
  fr: {
    connecting: 'Connexion\u2026',
    disconnected: 'D\u00e9connect\u00e9',
    translation: 'Traduction',
    bilingual: 'Bilingue',
    chooseLayout: 'Choisir la mise en page',
    chooseLanguage: 'Langue',
    layoutSlideAndTranslation: 'Diapositive et traduction',
    layoutBilingualView: 'Vue bilingue',
    layoutSlideAndListen: 'Diapositive et écoute',
      componentListen: 'Écouter',
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
    jumpToLatest: '\u2193 Nouveau',
    listenLive: 'Écouter en direct',
    stopAudio: 'Couper le son',
    englishTranscript: 'Transcription anglaise',
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
    downloadSession: 'Télécharger la session',
    statusTitle: 'État de la session',
    statusHealthTitle: 'État des composants',
    statusHealthPlaceholder: 'L’état en direct des composants apparaîtra ici.',
    statusNotReporting: 'Pas encore de données',
    statusCanaryTitle: 'Vérification préalable',
    statusCanaryPlaceholder: 'Un contrôle de bout en bout avant le service s’exécutera ici.',
    statusExportTitle: 'Exporter la session',
    statusExportDescription:
      'Téléchargez les notes, les traductions de diapositives et les transcriptions en direct de cette session dans un seul fichier HTML lisible.',
    statusTranscriptsTitle: 'Transcriptions en direct',
    statusTranscriptsEmpty: 'Aucune transcription en direct dans cette session pour l’instant.',
    statusTranscriptSource: 'source',
    statusTranscriptNoUpdates: 'Aucune mise à jour depuis le chargement de la page',
    componentSourceText: 'Texte source',
    componentTranslatedText: 'Texte traduit',
    componentBilingual: 'Vue bilingue',
    componentCurrentSlide: 'Diapositive actuelle',
    slideReviewTitle: 'Révision des traductions de diapositives',
    slidesInputLabel: 'Diapositives de l’élément (séparez par une ligne vide ou --)',
    loadOnAirItem: 'Charger l’élément à l’antenne',
    suggestTranslations: 'Suggérer',
    suggesting: 'Suggestion…',
    bibleLookupsLabel: 'Recherches bibliques',
    bibleLookupFound: 'Trouvé en',
    bibleLookupMissing: 'Aucun texte canonique trouvé',
    save: 'Enregistrer',
    saveAll: 'Tout enregistrer',
    saving: 'Enregistrement…',
    statusReviewed: 'Révisé',
    statusUnsaved: 'Non enregistré',
    reviewSourceHeader: 'Source',
    noSlidesToReview: 'Saisissez ou chargez un élément pour réviser ses diapositives.',
    editorOnlyReview: 'Ouvrez cette page avec #editor pour modifier et enregistrer les traductions.',
    reviewSlidesLink: 'Réviser les traductions de diapositives',
    unreviewedBadge: 'non révisé',
    conversationHeader: 'Conversation avec l’agent',
    noConversation: 'Aucune conversation pour l’instant — cliquez sur Suggérer pour en démarrer une.',
    followUpPlaceholder: 'Posez une question ou donnez un retour…',
    sendMessage: 'Envoyer',
    selectItemLabel: 'Élément du service',
    sourceChangedWarning: 'Les diapositives source ont changé depuis cette traduction.',
    agentThinking: 'L’agent travaille…',
  },
  es: {
    connecting: 'Conectando\u2026',
    disconnected: 'Desconectado',
    translation: 'Traducci\u00f3n',
    bilingual: 'Biling\u00fce',
    chooseLayout: 'Elegir dise\u00f1o',
    chooseLanguage: 'Idioma',
    layoutSlideAndTranslation: 'Diapositiva y traducci\u00f3n',
    layoutBilingualView: 'Vista biling\u00fce',
    layoutSlideAndListen: 'Diapositiva y escucha',
      componentListen: 'Escuchar',
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
    jumpToLatest: '\u2193 Nuevo',
    listenLive: 'Escuchar en vivo',
    stopAudio: 'Detener audio',
    englishTranscript: 'Transcripción en inglés',
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
    downloadSession: 'Descargar sesión',
    statusTitle: 'Estado de la sesión',
    statusHealthTitle: 'Estado de los componentes',
    statusHealthPlaceholder: 'El estado en vivo de los componentes aparecerá aquí.',
    statusNotReporting: 'Sin datos todavía',
    statusCanaryTitle: 'Verificación previa',
    statusCanaryPlaceholder: 'Aquí se ejecutará una comprobación de extremo a extremo antes del servicio.',
    statusExportTitle: 'Exportar sesión',
    statusExportDescription:
      'Descargue las notas, las traducciones de diapositivas y las transcripciones en vivo de esta sesión en un solo archivo HTML legible.',
    statusTranscriptsTitle: 'Transcripciones en vivo',
    statusTranscriptsEmpty: 'Aún no hay transcripciones en vivo en esta sesión.',
    statusTranscriptSource: 'fuente',
    statusTranscriptNoUpdates: 'Sin actualizaciones desde que se cargó la página',
    componentSourceText: 'Texto fuente',
    componentTranslatedText: 'Texto traducido',
    componentBilingual: 'Vista biling\u00fce',
    componentCurrentSlide: 'Diapositiva actual',
    slideReviewTitle: 'Revisi\u00f3n de traducciones de diapositivas',
    slidesInputLabel: 'Diapositivas del elemento (separe con una l\u00ednea en blanco o --)',
    loadOnAirItem: 'Cargar elemento al aire',
    suggestTranslations: 'Sugerir',
    suggesting: 'Sugiriendo\u2026',
    bibleLookupsLabel: 'Consultas b\u00edblicas',
    bibleLookupFound: 'Encontrado en',
    bibleLookupMissing: 'No se encontr\u00f3 texto can\u00f3nico',
    save: 'Guardar',
    saveAll: 'Guardar todo',
    saving: 'Guardando\u2026',
    statusReviewed: 'Revisado',
    statusUnsaved: 'Sin guardar',
    reviewSourceHeader: 'Fuente',
    noSlidesToReview: 'Ingrese o cargue un elemento para revisar sus diapositivas.',
    editorOnlyReview: 'Abra esta p\u00e1gina con #editor para editar y guardar traducciones.',
    reviewSlidesLink: 'Revisar traducciones de diapositivas',
    unreviewedBadge: 'sin revisar',
    conversationHeader: 'Conversación con el agente',
    noConversation: 'Aún no hay conversación — pulse Sugerir para iniciar una.',
    followUpPlaceholder: 'Haga una pregunta o dé su opinión…',
    sendMessage: 'Enviar',
    selectItemLabel: 'Elemento del servicio',
    sourceChangedWarning: 'Las diapositivas de origen cambiaron desde esta traducción.',
    agentThinking: 'El agente está trabajando…',
  },
  ht: {
    connecting: 'Koneksyon\u2026',
    disconnected: 'Dekonekte',
    translation: 'Tradiksyon',
    bilingual: 'Bileng',
    chooseLayout: 'Chwazi Dispozisyon',
    chooseLanguage: 'Lang',
    layoutSlideAndTranslation: 'Diapozitiv ak Tradiksyon',
    layoutBilingualView: 'Vi Bileng',
    layoutSlideAndListen: 'Diapozitiv ak \u00c9coute',
      componentListen: 'Koute',
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
    jumpToLatest: '↓ Nouvo',
    listenLive: 'Koute an dirèk',
    stopAudio: 'Sispann odyo',
    englishTranscript: 'Transkripsyon anglè',
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
    downloadSession: 'Telechaje sesyon an',
    statusTitle: 'Estati sesyon an',
    statusHealthTitle: 'Estati konpozan yo',
    statusHealthPlaceholder: 'Estati konpozan yo an dirèk ap parèt isit la.',
    statusNotReporting: 'Poko gen done',
    statusCanaryTitle: 'Tchèk anvan sèvis la',
    statusCanaryPlaceholder: 'Yon tchèk konplè anvan sèvis la ap fèt isit la.',
    statusExportTitle: 'Ekspòte sesyon an',
    statusExportDescription:
      'Telechaje nòt yo, tradiksyon dyapozitiv yo, ak transkripsyon an dirèk sesyon sa a nan yon sèl fichye HTML ki fasil pou li.',
    statusTranscriptsTitle: 'Transkripsyon an dirèk',
    statusTranscriptsEmpty: 'Poko gen transkripsyon an dirèk nan sesyon sa a.',
    statusTranscriptSource: 'sous',
    statusTranscriptNoUpdates: 'Pa gen mizajou depi paj la chaje',
    componentSourceText: 'Teks sous',
    componentTranslatedText: 'Teks tradui',
    componentBilingual: 'Vi Bileng',
    componentCurrentSlide: 'Diapozitiv aktyèl',
    slideReviewTitle: 'Revizyon Tradiksyon Diapozitiv',
    slidesInputLabel: 'Diapozitiv eleman an (separe ak yon liy vid oswa --)',
    loadOnAirItem: 'Chaje eleman k ap pase a',
    suggestTranslations: 'Sijere',
    suggesting: 'Ap sijere…',
    bibleLookupsLabel: 'Rechèch biblik',
    bibleLookupFound: 'Jwenn nan',
    bibleLookupMissing: 'Pa jwenn tèks kanonik',
    save: 'Anrejistre',
    saveAll: 'Anrejistre tout',
    saving: 'Ap anrejistre…',
    statusReviewed: 'Revize',
    statusUnsaved: 'Pa anrejistre',
    reviewSourceHeader: 'Sous',
    noSlidesToReview: 'Antre oswa chaje yon eleman pou revize diapozitiv li yo.',
    editorOnlyReview: 'Ouvri paj sa a ak #editor pou modifye ak anrejistre tradiksyon.',
    reviewSlidesLink: 'Revize Tradiksyon Diapozitiv',
    unreviewedBadge: 'pa revize',
    conversationHeader: 'Konvèsasyon ak ajan an',
    noConversation: 'Poko gen konvèsasyon — klike Sijere pou kòmanse youn.',
    followUpPlaceholder: 'Poze yon kesyon oswa bay yon kòmantè…',
    sendMessage: 'Voye',
    selectItemLabel: 'Eleman sèvis la',
    sourceChangedWarning: 'Diapozitiv sous yo chanje depi tradiksyon sa a.',
    agentThinking: 'Ajan an ap travay…',
  },
};

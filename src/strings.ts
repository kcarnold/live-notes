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

  // Navigation
  goHome: string;

  // Layout diagram component labels
  componentSourceText: string;
  componentTranslatedText: string;
  componentBilingual: string;
  componentCurrentSlide: string;

  // Slide translation review
  slideReviewTitle: string;
  slidesInputLabel: string;
  loadOnAirItem: string;
  suggestTranslations: string;
  suggesting: string;
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
    slideReviewTitle: 'Slide Translation Review',
    slidesInputLabel: 'Item slides (separate slides with a blank line or --)',
    loadOnAirItem: 'Load on-air item',
    suggestTranslations: 'Suggest',
    suggesting: 'Suggesting…',
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
  },
  fr: {
    connecting: 'Connexion\u2026',
    disconnected: 'D\u00e9connect\u00e9',
    translation: 'Traduction',
    bilingual: 'Bilingue',
    chooseLayout: 'Choisir la mise en page',
    layoutSlideAndTranslation: 'Diapositive et traduction',
    layoutBilingualView: 'Vue bilingue',
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
    slideReviewTitle: 'Révision des traductions de diapositives',
    slidesInputLabel: 'Diapositives de l’élément (séparez par une ligne vide ou --)',
    loadOnAirItem: 'Charger l’élément à l’antenne',
    suggestTranslations: 'Suggérer',
    suggesting: 'Suggestion…',
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
  },
  es: {
    connecting: 'Conectando\u2026',
    disconnected: 'Desconectado',
    translation: 'Traducci\u00f3n',
    bilingual: 'Biling\u00fce',
    chooseLayout: 'Elegir dise\u00f1o',
    layoutSlideAndTranslation: 'Diapositiva y traducci\u00f3n',
    layoutBilingualView: 'Vista biling\u00fce',
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
    slideReviewTitle: 'Revisi\u00f3n de traducciones de diapositivas',
    slidesInputLabel: 'Diapositivas del elemento (separe con una l\u00ednea en blanco o --)',
    loadOnAirItem: 'Cargar elemento al aire',
    suggestTranslations: 'Sugerir',
    suggesting: 'Sugiriendo\u2026',
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
  },
  ht: {
    connecting: 'Koneksyon\u2026',
    disconnected: 'Dekonekte',
    translation: 'Tradiksyon',
    bilingual: 'Bileng',
    chooseLayout: 'Chwazi Dispozisyon',
    layoutSlideAndTranslation: 'Diapozitiv ak Tradiksyon',
    layoutBilingualView: 'Vi Bileng',
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
    slideReviewTitle: 'Revizyon Tradiksyon Diapozitiv',
    slidesInputLabel: 'Diapozitiv eleman an (separe ak yon liy vid oswa --)',
    loadOnAirItem: 'Chaje eleman k ap pase a',
    suggestTranslations: 'Sijere',
    suggesting: 'Ap sijere…',
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
  },
};

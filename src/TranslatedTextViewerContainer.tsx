import React, { useMemo } from 'react';
import { useAsPlainText } from './yjsUtils';
import { translatedTextKeyForLanguage } from './translationUtils';
import TranslatedTextViewer from './TranslatedTextViewer';

interface TranslatedTextViewerContainerProps {
  language: string;
  fontSize?: number;
  headerControls?: React.ReactNode;
}

/**
 * Container component that connects TranslatedTextViewer to Yjs.
 *
 * This wrapper:
 * 1. Fetches translated text from Yjs shared document
 * 2. Splits text into lines
 * 3. Passes lines to the pure TranslatedTextViewer component
 */
const TranslatedTextViewerContainer: React.FC<TranslatedTextViewerContainerProps> = ({
  language,
  fontSize,
  headerControls
}) => {
  const yJsKey = translatedTextKeyForLanguage(language);
  const [translatedText] = useAsPlainText(yJsKey);

  const lines = useMemo(() => {
    const lines = translatedText ? translatedText.split('\n') : [];
    return lines.filter(line => line.trim() !== '');
  }, [translatedText]);

  return (
    <TranslatedTextViewer
      lines={lines}
      language={language}
      fontSize={fontSize}
      headerControls={headerControls}
    />
  );
};

export default TranslatedTextViewerContainer;

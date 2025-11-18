# Tauri Speech Recognition Spike

This is a proof-of-concept Tauri application comparing Web Speech API and macOS native speech recognition.

## Overview

This spike demonstrates two approaches for speech recognition in a Tauri desktop application:

1. **Web Speech API** - Cross-platform browser-based speech recognition (fully implemented)
2. **macOS Native Speech API** - Platform-specific on-device recognition (architecture complete, stub implementation)

See [SPIKE_REPORT.md](./SPIKE_REPORT.md) for a detailed comparison and analysis.

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- Rust 1.70+ (for Tauri)
- macOS (for full native API testing)

### Installation

```bash
# Install dependencies
npm install
```

### Development

```bash
# Run in browser (Web Speech API only)
npm run dev

# Run as Tauri desktop app (both implementations)
npm run tauri dev
```

### Building

```bash
# Build frontend
npm run build

# Build Tauri app (creates native executable)
npm run tauri build
```

## Features

### Web Speech API (✅ Working)
- ✅ Continuous speech recognition
- ✅ Interim results (real-time transcription)
- ✅ Auto-restart on disconnection
- ✅ Cross-platform (macOS, Windows, Linux where supported)
- ⚠️ Requires internet connection

### macOS Native API (🔨 Architecture Complete)
- 🔨 On-device recognition (offline capable)
- 🔨 Lower latency
- 🔨 Better privacy
- 📝 Stub implementation with detailed architecture
- 📝 See `src-tauri/src/macos_speech.rs` for implementation roadmap

## Project Structure

```
tauri-speech-client/
├── src/
│   ├── main.ts              # Frontend TypeScript
│   │   ├── WebSpeechRecognizer class (working)
│   │   └── NativeSpeechRecognizer class (calls Rust)
│   └── styles.css           # UI styling
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs           # Tauri commands
│   │   └── macos_speech.rs  # Native macOS implementation (stub)
│   └── Cargo.toml           # Rust dependencies
├── index.html               # UI layout
├── SPIKE_REPORT.md          # Detailed comparison and analysis
└── README.md                # This file
```

## Usage

1. Launch the application
2. Click "Start Web Speech" to test the Web Speech API implementation
3. Speak into your microphone
4. See real-time transcription with interim results (gray) and final results (black)
5. Click "Stop" to end the session

For the native API (stub):
- Click "Start Native Speech" to see the stub in action
- Check console logs for implementation notes
- See error message on non-macOS platforms

## Implementation Notes

### Web Speech API
The Web Speech API implementation is production-ready and includes:
- Continuous recognition with auto-restart
- Interim and final result handling
- Error handling and recovery
- Microphone permission management
- Visual feedback for transcript updates

### macOS Native API
The native API has a complete architecture but is not fully implemented. To complete it:

1. **Add permissions to `Info.plist`**:
   - `NSSpeechRecognitionUsageDescription`
   - `NSMicrophoneUsageDescription`

2. **Implement in `src-tauri/src/macos_speech.rs`**:
   - Authorization flow
   - SFSpeechRecognizer initialization
   - AVAudioEngine setup
   - Audio tap installation
   - Recognition task with event emission

3. **Estimated effort**: 1-2 weeks for full implementation + testing

See detailed implementation notes in `src-tauri/src/macos_speech.rs`.

## Comparison

| Feature | Web Speech API | macOS Native API |
|---------|----------------|------------------|
| **Status** | ✅ Working | 🔨 Architecture only |
| **Platform** | Cross-platform | macOS only |
| **Offline** | ❌ No | ✅ Yes |
| **Privacy** | ⚠️ Cloud | ✅ On-device |
| **Latency** | 200-500ms | 50-150ms |
| **Complexity** | Low | High |
| **Implementation** | ~150 lines TS | ~300+ lines Rust |

## Recommendations

For the Live Notes project:
1. **Use Web Speech API** for initial release (already working)
2. **Consider Tauri wrapper** for desktop app benefits
3. **Add Native API later** as optional enhancement for offline/privacy users

See [SPIKE_REPORT.md](./SPIKE_REPORT.md) for detailed analysis and migration path.

## Troubleshooting

### Web Speech API not working
- Ensure microphone permissions are granted
- Check browser console for errors
- Verify internet connection (required for cloud processing)
- Try a different browser (Chrome/Edge have best support)

### Tauri build fails
- Ensure Rust is installed: `rustup --version`
- Update Rust: `rustup update`
- Clear cargo cache: `cargo clean`
- Reinstall dependencies: `rm -rf node_modules && npm install`

### Microphone not detected
- Check system microphone settings
- Grant microphone permissions to the app
- Test with another audio application
- Restart the application

## Contributing

This is a spike/proof-of-concept. To extend it:

1. For Web Speech API improvements: Edit `src/main.ts` (WebSpeechRecognizer class)
2. For Native API implementation: Complete `src-tauri/src/macos_speech.rs`
3. For UI changes: Edit `index.html` and `src/styles.css`

## License

Part of the Live Notes project.

## Related Files

- [SPIKE_REPORT.md](./SPIKE_REPORT.md) - Detailed technical comparison and recommendations
- [../CLAUDE.md](../CLAUDE.md) - Main project documentation
- [../src/SpeechTranscriber.tsx](../src/SpeechTranscriber.tsx) - Current web implementation

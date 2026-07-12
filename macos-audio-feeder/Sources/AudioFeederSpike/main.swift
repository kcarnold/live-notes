import Foundation
import AVFoundation
import LiveKit
import AudioFeederCore

// =============================================================================
// AudioFeederSpike — de-risk the linchpin of the whole project.
//
// Question this answers: on macOS, does the LiveKit Swift SDK's custom-audio path
// (AudioManager manual rendering + mixer.capture(appAudio:)) actually publish audio that
// a listener/translator bot receives? If yes, the full app can synthesize its audio
// (one extracted board channel) the same way. If no, we fall back to an Aggregate Device
// + the SDK's normal device capture.
//
// What it does: fetches an organizer token from the live-notes server, joins the session's
// LiveKit room as `organizer-host`, and publishes a steady sine tone via the custom-audio
// API. Join the same session in a browser as a listener and confirm you hear the tone.
//
// Usage:
//   swift run AudioFeederSpike --server-url https://dev8.kenarnold.org --doc doc-2025-06-30
//   # --doc is optional; defaults to today's doc-YYYY-MM-DD. Add --freq 440 to change pitch.
//
// NOTE: The exact AudioManager custom-audio API names (setManualRenderingMode / mixer /
// capture(appAudio:)) are taken from the SDK's Docs/audio.md. If they don't resolve against
// the installed SDK version, this spike is exactly where to reconcile them — see the marked
// section below.
// =============================================================================

struct Args {
    var serverURL: String
    var docID: String
    var frequency: Double

    static func parse() -> Args {
        var serverURL: String?
        var docID: String?
        var frequency = 440.0
        var it = CommandLine.arguments.dropFirst().makeIterator()
        while let arg = it.next() {
            switch arg {
            case "--server-url", "-s": serverURL = it.next()
            case "--doc", "-d": docID = it.next()
            case "--freq", "-f": if let v = it.next(), let d = Double(v) { frequency = d }
            case "--help", "-h":
                printUsageAndExit(code: 0)
            default:
                FileHandle.standardError.write(Data("Unknown argument: \(arg)\n".utf8))
                printUsageAndExit(code: 2)
            }
        }
        guard let server = serverURL else {
            FileHandle.standardError.write(Data("Missing --server-url\n".utf8))
            printUsageAndExit(code: 2)
        }
        let resolvedDoc = docID ?? FeederConfig().resolvedDocID()
        return Args(serverURL: server, docID: resolvedDoc, frequency: frequency)
    }

    static func printUsageAndExit(code: Int32) -> Never {
        let usage = """
        Usage: AudioFeederSpike --server-url <url> [--doc <doc-id>] [--freq <hz>]

          --server-url, -s   live-notes server base URL (issues the LiveKit token)
          --doc, -d          session doc id / LiveKit room (default: today's doc-YYYY-MM-DD)
          --freq, -f         tone frequency in Hz (default: 440)

        """
        FileHandle.standardError.write(Data(usage.utf8))
        exit(code)
    }
}

/// Build a mono float32 PCM buffer from raw samples at `sampleRate`.
func makeBuffer(_ samples: [Float], sampleRate: Double) -> AVAudioPCMBuffer? {
    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                     sampleRate: sampleRate,
                                     channels: 1,
                                     interleaved: false),
          let buffer = AVAudioPCMBuffer(pcmFormat: format,
                                        frameCapacity: AVAudioFrameCount(samples.count)) else {
        return nil
    }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { src in
        buffer.floatChannelData![0].update(from: src.baseAddress!, count: samples.count)
    }
    return buffer
}

/// Taps the frames actually handed to WebRTC on the local (published) audio track and prints a
/// once-per-second heartbeat with the RMS level. Non-silent RMS here means audio really is being
/// published — so any "no sound" problem is downstream (subscription/listener). Silence/no frames
/// means the app-audio → engine path never delivered anything.
final class TapRenderer: NSObject, AudioRenderer, @unchecked Sendable {
    private let lock = NSLock()
    private var frames = 0
    private var sumSquares = 0.0
    private var lastPrint = Date()

    func render(pcmBuffer: AVAudioPCMBuffer) {
        let n = Int(pcmBuffer.frameLength)
        var energy = 0.0
        if let ch = pcmBuffer.floatChannelData {
            for i in 0..<n { let v = Double(ch[0][i]); energy += v * v }
        } else if let ch = pcmBuffer.int16ChannelData {
            for i in 0..<n { let v = Double(ch[0][i]) / 32768.0; energy += v * v }
        }
        lock.lock()
        frames += n
        sumSquares += energy
        let now = Date()
        if now.timeIntervalSince(lastPrint) >= 1.0 {
            let rms = frames > 0 ? (sumSquares / Double(frames)).squareRoot() : 0
            print(String(format: "[tap] local track: %d frames/s, rms=%.4f", frames, rms))
            frames = 0; sumSquares = 0; lastPrint = now
        }
        lock.unlock()
    }
}

let args = Args.parse()
let sampleRate = 48_000.0

// Route the SDK's logs to stdout. The default OSLogger sends everything to macOS unified
// logging (subsystem io.livekit.sdk) where it's invisible in a terminal — so warnings like
// "Engine is not running" from the app-audio path never show. PrintLogger prints them here.
// Must be set before any other SDK logging happens.
LiveKitSDK.setLogger(PrintLogger(minLevel: .debug))

print("[spike] server = \(args.serverURL)")
print("[spike] room   = \(args.docID)")
print("[spike] tone   = \(args.frequency) Hz")

// 1) Fetch an organizer token (same contract as the browser broadcast page).
let tokenClient = LiveKitTokenClient(serverURL: args.serverURL)
let token: LiveKitToken
do {
    token = try await tokenClient.fetchToken(room: args.docID)
    print("[spike] got token; livekit serverUrl = \(token.serverUrl)")
} catch {
    FileHandle.standardError.write(Data("[spike] token fetch failed: \(error)\n".utf8))
    exit(1)
}

// 2) Connect to the room.
let room = Room()
do {
    try await room.connect(url: token.serverUrl, token: token.token)
    print("[spike] connected to room \(args.docID) as \(LiveKitTokenClient.organizerIdentity)")
} catch {
    FileHandle.standardError.write(Data("[spike] room connect failed: \(error)\n".utf8))
    exit(1)
}

// 3) ----- CUSTOM-AUDIO PATH (the thing under test) -----------------------------------
//    Put the engine in manual rendering mode so the physical mic is never opened, then
//    publish a local audio track that the mixer feeds from our buffers.
do {
    try AudioManager.shared.setManualRenderingMode(true)
    print("[spike] manual rendering mode ON")
} catch {
    FileHandle.standardError.write(Data("[spike] setManualRenderingMode failed: \(error)\n".utf8))
    // Keep going — on some versions publishing still works; the point is to learn.
}

// Publish the local audio track. In manual rendering mode this creates the published
// track without accessing the microphone; the mixer supplies its audio.
do {
    try await room.localParticipant.setMicrophone(enabled: true)
    print("[spike] local audio track published")
} catch {
    FileHandle.standardError.write(Data("[spike] publish track failed: \(error)\n".utf8))
    exit(1)
}

// Tap the published local track so we can see whether real frames reach WebRTC. The track may
// take a moment to appear after setMicrophone; poll briefly, then attach the renderer.
let tap = TapRenderer()
var attached = false
for _ in 0..<20 {
    if let pub = room.localParticipant.localAudioTracks.first,
       let track = pub.track as? LocalAudioTrack {
        track.add(audioRenderer: tap)
        attached = true
        print("[spike] tap attached to local audio track \(pub.sid)")
        break
    }
    try? await Task.sleep(nanoseconds: 100_000_000)
}
if !attached { print("[spike] WARNING: never found a local audio track to tap") }

// 4) Feed a continuous sine tone on a background task.
// IMPORTANT: keep each buffer at or below the engine's maximumFramesToRender (logged as 3072 =
// 64ms @ 48k). The SDK's MixerEngineObserver warns that exceeding it triggers
// kAudioUnitErr_TooManyFramesToProcess (-10874), which renders as silence — our first attempt
// pushed 4800-frame (100ms) buffers and the published track was dead silent (rms=0). Use 50ms
// buffers, pushed a touch faster than realtime so the player node never underruns.
var generator = ToneGenerator(frequency: args.frequency, amplitude: 0.25, sampleRate: sampleRate)
let framesPerPush = Int(sampleRate * 0.05) // 2400 frames = 50ms, under the 3072 render cap

let feeder = Task {
    var pushes = 0
    var lastBeat = Date()
    while !Task.isCancelled {
        let samples = generator.next(framesPerPush)
        if let buffer = makeBuffer(samples, sampleRate: sampleRate) {
            // <<< API UNDER TEST >>> feed app audio to the publish mixer.
            AudioManager.shared.mixer.capture(appAudio: buffer)
            pushes += 1
        }
        let now = Date()
        if now.timeIntervalSince(lastBeat) >= 1.0 {
            print("[feed] pushed \(pushes) buffers/s; manualRendering=\(AudioManager.shared.isManualRenderingMode)")
            pushes = 0; lastBeat = now
        }
        try? await Task.sleep(nanoseconds: 40_000_000) // 40 ms sleep vs 50 ms of audio → slight lead
    }
}

print("[spike] publishing tone. Join \(args.docID) in a browser as a listener to verify.")
print("[spike] press Ctrl-C to stop.")

// Keep the process alive until interrupted.
let interrupted = DispatchSemaphore(value: 0)
let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
signal(SIGINT, SIG_IGN)
sigintSource.setEventHandler { interrupted.signal() }
sigintSource.resume()
interrupted.wait()

print("\n[spike] shutting down…")
feeder.cancel()
try? await room.disconnect()
print("[spike] done.")

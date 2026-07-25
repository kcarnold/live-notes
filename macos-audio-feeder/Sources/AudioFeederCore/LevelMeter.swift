import Foundation

/// Audio level computation for the UI meter. The array-based math is pure and builds
/// everywhere; the `AVAudioPCMBuffer` convenience is macOS-only.
public enum LevelMeter {

    /// Root-mean-square amplitude of mono float samples in `[0, 1]` (for normalized PCM).
    public static func rms(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Double = 0
        for s in samples { sum += Double(s) * Double(s) }
        return Float((sum / Double(samples.count)).squareRoot())
    }

    /// Map an RMS amplitude to a `[0, 1]` meter fill. Speech RMS sits well below 1.0, so we
    /// apply gain and clamp — mirroring the browser meter, which scales volume by ~140x
    /// (see `MicLevelMeter` in BroadcastControl.tsx).
    public static func displayLevel(rms: Float, gain: Float = 5.0) -> Float {
        max(0, min(1, rms * gain))
    }

    /// Convenience: dBFS for an RMS amplitude (−∞ floored to −120 dB).
    public static func dBFS(rms: Float) -> Float {
        rms <= 0 ? -120 : max(-120, 20 * log10(rms))
    }
}

#if canImport(AVFoundation)
import AVFoundation

extension LevelMeter {
    /// RMS over channel 0 of a non-interleaved float buffer (the format our mono capture uses).
    public static func rms(buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        let n = Int(buffer.frameLength)
        let ptr = channelData[0]
        var sum: Double = 0
        for i in 0..<n {
            let s = Double(ptr[i])
            sum += s * s
        }
        return Float((sum / Double(n)).squareRoot())
    }
}
#endif

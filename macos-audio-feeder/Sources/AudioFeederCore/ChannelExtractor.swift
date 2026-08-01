import Foundation

/// Extracts a single channel from multichannel audio.
public enum ChannelExtractor {

    /// Pick channel `index` from per-channel sample arrays. Returns an empty array if the
    /// index is out of range (caller treats that as "channel not present").
    public static func pickChannel(_ channels: [[Float]], _ index: Int) -> [Float] {
        guard index >= 0, index < channels.count else { return [] }
        return channels[index]
    }
}

#if canImport(AVFoundation)
import AVFoundation

extension ChannelExtractor {
    /// Copy `channel` of a non-interleaved float `source` buffer into a new mono buffer at
    /// the same sample rate. Returns nil if the source isn't float/non-interleaved or the
    /// channel is out of range — the caller falls back to "waiting for valid audio".
    public static func extractMono(from source: AVAudioPCMBuffer, channel: Int) -> AVAudioPCMBuffer? {
        guard let srcData = source.floatChannelData else { return nil }
        let channelCount = Int(source.format.channelCount)
        guard channel >= 0, channel < channelCount else { return nil }

        let frames = source.frameLength
        guard frames > 0,
              let monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                             sampleRate: source.format.sampleRate,
                                             channels: 1,
                                             interleaved: false),
              let out = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: frames),
              let dstData = out.floatChannelData else { return nil }

        out.frameLength = frames
        memcpy(dstData[0], srcData[channel], Int(frames) * MemoryLayout<Float>.size)
        return out
    }
}
#endif

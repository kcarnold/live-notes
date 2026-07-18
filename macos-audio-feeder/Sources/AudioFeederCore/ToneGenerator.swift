import Foundation

/// Generates a sine tone as raw float samples. Pure and portable so it can drive both the
/// spike (a known signal to publish) and unit tests.
public struct ToneGenerator {
    public var frequency: Double
    public var amplitude: Float
    public var sampleRate: Double
    private var phase: Double = 0

    public init(frequency: Double = 440, amplitude: Float = 0.25, sampleRate: Double = 48_000) {
        self.frequency = frequency
        self.amplitude = amplitude
        self.sampleRate = sampleRate
    }

    /// Produce the next `count` samples, advancing the phase so successive calls are
    /// continuous (no clicks at buffer boundaries).
    public mutating func next(_ count: Int) -> [Float] {
        guard count > 0 else { return [] }
        var out = [Float](repeating: 0, count: count)
        let increment = 2.0 * Double.pi * frequency / sampleRate
        for i in 0..<count {
            out[i] = amplitude * Float(sin(phase))
            phase += increment
            if phase > 2.0 * Double.pi { phase -= 2.0 * Double.pi }
        }
        return out
    }
}

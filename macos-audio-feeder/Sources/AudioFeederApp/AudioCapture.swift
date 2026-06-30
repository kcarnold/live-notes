import Foundation
import AVFoundation
import CoreAudio
import AudioFeederCore

enum AudioCaptureError: Error, CustomStringConvertible {
    case couldNotSetDevice(OSStatus)
    case noInputAudioUnit
    case engineStartFailed(Error)

    var description: String {
        switch self {
        case let .couldNotSetDevice(status): return "could not bind input device (OSStatus \(status))"
        case .noInputAudioUnit: return "input node has no audio unit"
        case let .engineStartFailed(error): return "audio engine failed to start: \(error)"
        }
    }
}

/// Captures audio from a chosen CoreAudio input device, pulls one channel, and emits a mono
/// buffer plus a level reading per tap. Pure channel/level math lives in AudioFeederCore.
final class AudioCapture {
    /// Delivered on the tap's (real-time) thread; keep handlers light.
    var onMonoBuffer: ((AVAudioPCMBuffer) -> Void)?
    var onLevel: ((Float) -> Void)?

    private let engine = AVAudioEngine()
    private let channelIndex: Int
    private var running = false

    init(channelIndex: Int) {
        self.channelIndex = channelIndex
    }

    func start(deviceID: AudioDeviceID) throws {
        guard !running else { return }

        // Bind the engine's input node to the selected hardware device (macOS).
        let inputNode = engine.inputNode
        guard let audioUnit = inputNode.audioUnit else { throw AudioCaptureError.noInputAudioUnit }
        var device = deviceID
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &device,
            UInt32(MemoryLayout<AudioDeviceID>.size))
        guard status == noErr else { throw AudioCaptureError.couldNotSetDevice(status) }

        // Tap the input in its native (multichannel) format; extract our channel per buffer.
        let format = inputNode.inputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            guard let mono = ChannelExtractor.extractMono(from: buffer, channel: self.channelIndex) else {
                return
            }
            self.onLevel?(LevelMeter.rms(buffer: mono))
            self.onMonoBuffer?(mono)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            throw AudioCaptureError.engineStartFailed(error)
        }
        running = true
    }

    func stop() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
    }

    var isRunning: Bool { running }
}

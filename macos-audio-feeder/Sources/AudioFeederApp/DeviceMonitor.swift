import Foundation
import CoreAudio

/// A selectable CoreAudio input device.
struct AudioInputDevice: Identifiable, Hashable {
    let id: AudioDeviceID
    let uid: String
    let name: String
    let inputChannelCount: Int
}

/// Enumerates CoreAudio input devices and notifies on hot-plug changes. Devices are keyed
/// by **UID** (stable across reconnects), not the transient AudioDeviceID/index.
final class DeviceMonitor {
    /// Called on the main queue whenever the set of hardware devices changes.
    var onDevicesChanged: (() -> Void)?

    /// The exact block handed to `AudioObjectAddPropertyListenerBlock`. CoreAudio matches
    /// listeners by block identity, so removal has to pass *this* block back — a freshly
    /// written `{ _, _ in }` with the same shape matches nothing and silently leaves the
    /// listener installed.
    private var listenerBlock: AudioObjectPropertyListenerBlock?
    private var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)

    func startMonitoring() {
        guard listenerBlock == nil else { return }
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.onDevicesChanged?()
        }
        let status = AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject), &address, DispatchQueue.main, block)
        guard status == noErr else {
            Log.devices.error("failed to install hot-plug listener: OSStatus \(status, privacy: .public)")
            return
        }
        listenerBlock = block
    }

    func stopMonitoring() {
        guard let block = listenerBlock else { return }
        AudioObjectRemovePropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject), &address, DispatchQueue.main, block)
        listenerBlock = nil
    }

    /// All current input-capable devices.
    static func inputDevices() -> [AudioInputDevice] {
        deviceIDs().compactMap { id in
            let channels = inputChannelCount(id)
            guard channels > 0, let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) else {
                return nil
            }
            let name = stringProperty(id, kAudioObjectPropertyName) ?? uid
            return AudioInputDevice(id: id, uid: uid, name: name, inputChannelCount: channels)
        }
    }

    /// Resolve a configured UID to the current device, or nil if it isn't connected.
    static func device(forUID uid: String) -> AudioInputDevice? {
        inputDevices().first { $0.uid == uid }
    }

    // MARK: - CoreAudio plumbing

    private static func deviceIDs() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize) == noErr else {
            return []
        }
        let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var ids = [AudioDeviceID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &ids) == noErr else {
            return []
        }
        return ids
    }

    private static func inputChannelCount(_ device: AudioDeviceID) -> Int {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &dataSize) == noErr,
              dataSize > 0 else { return 0 }

        let bufferList = UnsafeMutableRawPointer.allocate(
            byteCount: Int(dataSize), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { bufferList.deallocate() }
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &dataSize, bufferList) == noErr else {
            return 0
        }
        let abl = UnsafeMutableAudioBufferListPointer(
            bufferList.assumingMemoryBound(to: AudioBufferList.self))
        return abl.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    private static func stringProperty(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var dataSize = UInt32(MemoryLayout<CFString?>.size)
        var cfString: CFString?
        let status = withUnsafeMutablePointer(to: &cfString) { ptr -> OSStatus in
            AudioObjectGetPropertyData(device, &address, 0, nil, &dataSize, ptr)
        }
        guard status == noErr, let result = cfString else { return nil }
        return result as String
    }
}

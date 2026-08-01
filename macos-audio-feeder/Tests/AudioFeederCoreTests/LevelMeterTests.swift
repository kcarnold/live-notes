import XCTest
@testable import AudioFeederCore

final class LevelMeterTests: XCTestCase {

    func testSilenceIsZero() {
        XCTAssertEqual(LevelMeter.rms([Float](repeating: 0, count: 128)), 0, accuracy: 1e-6)
    }

    func testEmptyIsZero() {
        XCTAssertEqual(LevelMeter.rms([]), 0, accuracy: 1e-6)
    }

    func testFullScaleConstantIsOne() {
        XCTAssertEqual(LevelMeter.rms([Float](repeating: 1, count: 64)), 1, accuracy: 1e-6)
    }

    func testSineRMSIsAmplitudeOverRootTwo() {
        var gen = ToneGenerator(frequency: 1000, amplitude: 1.0, sampleRate: 48_000)
        let samples = gen.next(48_000) // a full second -> many periods
        XCTAssertEqual(LevelMeter.rms(samples), Float(1.0 / 2.0.squareRoot()), accuracy: 0.01)
    }

    func testDisplayLevelClampsToUnitRange() {
        XCTAssertEqual(LevelMeter.displayLevel(rms: 0), 0, accuracy: 1e-6)
        XCTAssertEqual(LevelMeter.displayLevel(rms: 5.0, gain: 5.0), 1, accuracy: 1e-6)
        XCTAssertEqual(LevelMeter.displayLevel(rms: 0.1, gain: 5.0), 0.5, accuracy: 1e-6)
    }

    func testDBFSFloorsAtMinus120() {
        XCTAssertEqual(LevelMeter.dBFS(rms: 0), -120, accuracy: 1e-6)
        XCTAssertEqual(LevelMeter.dBFS(rms: 1), 0, accuracy: 1e-6)
    }
}

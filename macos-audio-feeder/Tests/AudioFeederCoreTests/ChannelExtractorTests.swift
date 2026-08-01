import XCTest
@testable import AudioFeederCore

final class ChannelExtractorTests: XCTestCase {

    func testPicksRequestedChannel() {
        let channels: [[Float]] = [[0, 0, 0], [1, 2, 3], [9, 9, 9]]
        XCTAssertEqual(ChannelExtractor.pickChannel(channels, 1), [1, 2, 3])
    }

    func testOutOfRangeReturnsEmpty() {
        let channels: [[Float]] = [[1, 2, 3]]
        XCTAssertEqual(ChannelExtractor.pickChannel(channels, 5), [])
        XCTAssertEqual(ChannelExtractor.pickChannel(channels, -1), [])
    }

    func testEmptyInputReturnsEmpty() {
        XCTAssertEqual(ChannelExtractor.pickChannel([], 0), [])
    }
}

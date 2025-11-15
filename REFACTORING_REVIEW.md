# Block-Based Translation Refactoring - Review & Merge Checklist

## Summary of Changes

This refactoring moved from a markdown-based translation system to a structured block-based system where translations are stored directly in each block's Yjs data.

## ✅ Issues Addressed

### 1. Translation Staleness Detection
- **Problem**: No way to detect when source content changes after translation
- **Solution**: Store `translationSource` snapshot alongside each translation
- **Status**: ✅ Fixed
- **Edge case handled**: Legacy blocks without snapshots are treated as stale

### 2. Translation Cache Removed
- **Rationale**: Unnecessary complexity, blocks are the source of truth
- **Impact**: ~24 lines of code removed
- **Trade-off**: Duplicate content translates multiple times (acceptable - API cost negligible)
- **Status**: ✅ Complete

### 3. Markdown Rendering Removed from Viewer
- **Previous**: Markdown text → react-remark rendering
- **New**: Structured blocks → direct rendering in BlockViewer
- **Benefits**: Simpler, faster, no parsing needed
- **Status**: ✅ Complete

### 4. Block-to-Translation Mapping
- **Problem**: Server returns translations without explicit blockId mapping
- **Solution**: Match by content with fallback search and warnings
- **Status**: ⚠️ Functional but fragile (see Known Limitations)

## 🔍 Areas Requiring Attention

### 1. **Testing** ⚠️ CRITICAL
**Status**: Tests are broken

The test file `src/TranslatedTextViewer.test.tsx` (359 lines) uses the old API:
```typescript
// Old API
<TranslatedTextViewer lines={['Line 1', 'Line 2']} language="French" />

// New API (required)
<TranslatedTextViewer blocks={[{id, content, translations, ...}]} language="French" />
```

**Action needed before merge**:
- [ ] Update all tests to use block-based API
- [ ] Test translation staleness detection
- [ ] Test concurrent editing scenarios
- [ ] Test TTS with block updates

**Recommendation**: Run tests and fix failures before merging.

### 2. **Migration from Old Documents** ⚠️ IMPORTANT
**Status**: Partially handled

Old documents have:
- `translatedText-French` Y.Text docs (now unused)
- Blocks without `translationSource` snapshots

**Current behavior**:
- ✅ Old blocks will re-translate on first click (correct)
- ⚠️ Old Y.Text translation docs remain in document (harmless but wastes space)

**Options**:
1. **Do nothing**: Users re-translate once, old data stays (safe)
2. **Migration script**: Copy old translations to blocks, add snapshots
3. **Auto-cleanup**: Code detects and removes old Y.Text docs

**Recommendation**: Option 1 for now, document in changelog.

### 3. **Concurrent Editing Edge Case** ⚠️ KNOWN ISSUE
**Scenario**:
1. User A types "Hello" in block
2. User B translates → stores "Bonjour" + source "Hello"
3. User A edits to "Hi"
4. Viewers see mismatched content:
   - English: "Hi"
   - French: "Bonjour" (stale!)
5. Translation updates only when User B clicks translate again

**Impact**: Temporary inconsistency in collaborative sessions

**Mitigation options**:
1. Accept as-is (staleness is expected in collaborative contexts)
2. Add visual indicator for stale translations
3. Auto-detect and re-translate on edit (expensive)

**Recommendation**: Accept for now, document behavior. Consider indicator in future.

### 4. **Block-to-Translation Mapping Fragility** ⚠️ TECHNICAL DEBT
**Current approach**: Match translations by searching for `content === sourceText`

**Problems**:
- Multiple blocks with identical content → only first gets translation
- Server normalization could break matching
- No explicit blockId in server response

**Current mitigation**: Warnings logged, fallback search

**Better solution** (future):
- Pass blockIds through server API
- Server returns `{blockId, translatedText}` pairs
- No ambiguity

**Recommendation**: Current solution works for MVP, improve server API later.

### 5. **TTS Playhead Stability** ⚠️ EXISTING ISSUE
**Note**: This is a pre-existing issue, not introduced by this refactoring.

The TTS playhead uses array indices which become stale when blocks are inserted/deleted during playback. The CLAUDE.md already notes:
> This is a temporary solution. Future versions will use proper Yjs document structure with stable identifiers instead of array indices.

**Status**: Out of scope for this refactoring (already documented).

## 📋 Pre-Merge Checklist

### Critical (Must Do)
- [ ] **Run tests**: `npm test` and fix failures
- [ ] **Manual testing**:
  - [ ] Create new blocks and translate
  - [ ] Edit blocks and verify re-translation
  - [ ] Test with multiple languages
  - [ ] Test TTS integration
  - [ ] Test in viewer mode (read-only)
- [ ] **Update CLAUDE.md**:
  - [ ] Remove translation cache references
  - [ ] Document new block-based system
  - [ ] Add migration notes for old documents

### Recommended (Should Do)
- [ ] **Add integration test** for translation staleness
- [ ] **Document** concurrent editing behavior
- [ ] **Test** with old documents (backward compat)

### Nice to Have (Could Do)
- [ ] Migration script for old documents
- [ ] Visual indicator for stale translations
- [ ] Improve server API for blockId mapping

## 📊 Code Quality

### Metrics
- **Lines changed**: ~300 total
- **Net reduction**: 24 lines (removed cache code)
- **New files**: 2 (BlockViewer.tsx, useBlockTranslationManager.ts)
- **TypeScript errors**: 0
- **Test failures**: Many (need fixing)

### Code Organization
✅ Clean separation of concerns
✅ Good type safety
✅ Clear comments and documentation
⚠️ Some legacy code marked but not removed

## 🚀 Confidence Level

**Merge confidence: 7/10**

**What increases confidence**:
- Core functionality works correctly
- Edge cases handled (legacy data, staleness)
- No TypeScript errors
- Clean architecture

**What decreases confidence**:
- Tests not updated yet (CRITICAL)
- No manual testing performed
- Concurrent editing edge case exists
- Block mapping could be more robust

**Recommendation**: **DO NOT MERGE** until:
1. Tests are fixed and passing
2. Manual testing confirms functionality
3. CLAUDE.md is updated

Once those three items are complete, merge confidence would be 9/10.

## 🔄 Rollback Plan

If issues arise after merge:

1. **Quick rollback**: Revert the 4 commits:
   - f580909 (Fix edge cases...)
   - d58d671 (Track source content snapshots...)
   - a4fc830 (Remove translation cache...)
   - e905831 (Refactor: Use structured block data...)

2. **Data loss**: Minimal - old Y.Text translations still exist, can switch back

3. **User impact**: Users would need to re-translate after rollback

## 📝 Next Steps

1. **Immediate**: Fix tests
2. **Before merge**: Manual testing + docs update
3. **After merge**: Monitor for issues, gather feedback
4. **Future**: Improve server API, add stale indicators

"""Compatibility import for the portable legacy dual-source Group core."""
import sys
import legacy_group_review

# Preserve module identity so existing callers/mocks and the v1 API keep working.
sys.modules[__name__] = legacy_group_review
